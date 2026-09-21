import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { ApiException } from '../../common/errors/api-exception';
import { loadStaffScope, type StaffScope } from '../../common/access/staff-scope';
import {
  normalizePermissions,
  PERMISSION_CATALOG,
  PERMISSION_PRESETS,
  type PermissionKey,
} from '../../common/access/permissions';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { isValidUsername, normalizeUsername } from '../../common/utils/username.util';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTeamMemberDto, UpdateTeamMemberDto } from './dto/team.dto';

/** Who is calling and what they may hand out. */
export interface TeamActor {
  kind: 'admin' | 'owner' | 'staff';
  userId: string;
  ownerId: string;
  /** Staff managers only: they cannot grant more than they hold. */
  scope: StaffScope | null;
}

@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtime?: RealtimeGatewayEmitter,
  ) {}

  catalog() {
    return { permissions: PERMISSION_CATALOG, presets: PERMISSION_PRESETS };
  }

  /**
   * Resolves the organisation a request works on.
   *  - admin: must name a venue; its owner is the organisation.
   *  - owner: themselves (a venue, if given, must be theirs).
   *  - staff with `team.manage`: their employer.
   */
  async resolveActor(user: AuthenticatedUser, venueId?: string): Promise<TeamActor> {
    if (user.roles.includes('admin')) {
      if (!venueId) throw new BadRequestException('venueId is required');
      const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { ownerId: true } });
      if (!venue) throw new NotFoundException('Venue not found');
      return { kind: 'admin', userId: user.id, ownerId: venue.ownerId, scope: null };
    }
    if (user.roles.includes('owner')) {
      if (venueId) {
        const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { ownerId: true } });
        if (!venue || venue.ownerId !== user.id) throw new ForbiddenException('Not your venue');
      }
      return { kind: 'owner', userId: user.id, ownerId: user.id, scope: null };
    }
    const scope = await loadStaffScope(this.prisma, user.id);
    if (!scope || !scope.permissions.includes('team.manage')) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return { kind: 'staff', userId: user.id, ownerId: scope.ownerId, scope };
  }

  async list(actor: TeamActor) {
    const [venues, rows] = await Promise.all([
      this.prisma.venue.findMany({
        where: { ownerId: actor.ownerId },
        select: { id: true, nameEn: true, nameAr: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.staffMember.findMany({
        where: { ownerId: actor.ownerId },
        include: {
          user: {
            select: { id: true, name: true, email: true, username: true, status: true, lastSeenAt: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      ownerId: actor.ownerId,
      venues,
      canGrant: actor.kind === 'staff' ? actor.scope!.permissions : null,
      members: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        name: row.user.name,
        email: row.user.email,
        username: row.user.username,
        title: row.title,
        permissions: row.permissions,
        venueIds: row.venueIds,
        status: row.user.status === 'active' ? 'active' : 'suspended',
        lastSeenAt: row.user.lastSeenAt,
        createdAt: row.createdAt,
        isYou: row.userId === actor.userId,
      })),
    };
  }

  async create(actor: TeamActor, dto: CreateTeamMemberDto) {
    const email = dto.email ? dto.email.toLowerCase() : null;
    const username = dto.username ? this.checkedUsername(dto.username) : null;
    if (!email && !username) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'LOGIN_REQUIRED', 'Give the person an email or a username to sign in with');
    }
    const permissions = this.grantable(actor, dto.permissions);
    if (!permissions.length) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'PERMISSIONS_REQUIRED', 'Pick at least one permission');
    }
    const venueIds = await this.venuesFor(actor, dto.venueIds);
    await this.assertLoginFree(email, username);
    const owner = await this.prisma.user.findUnique({
      where: { id: actor.ownerId },
      select: { countryCode: true },
    });
    const passwordHash = await bcrypt.hash(dto.password, this.config.get<number>('SALT_ROUNDS', 10));

    const member = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: dto.name,
          email,
          username,
          passwordHash,
          roles: ['staff'],
          // The manager vouches for the address; there is no verification mail to click.
          emailVerifiedAt: email ? new Date() : null,
          countryCode: owner?.countryCode ?? 'EG',
        },
      });
      const staff = await tx.staffMember.create({
        data: {
          userId: user.id,
          ownerId: actor.ownerId,
          title: dto.title || null,
          permissions,
          venueIds,
          createdById: actor.userId,
        },
      });
      await this.audit(tx, actor, 'team.member.created', staff.id, {
        userId: user.id,
        permissions,
        venueIds,
      });
      return staff;
    });
    return this.one(member.id);
  }

  async update(actor: TeamActor, staffId: string, dto: UpdateTeamMemberDto) {
    const member = await this.loadMember(actor, staffId);
    if (member.userId === actor.userId) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'CANNOT_EDIT_SELF', 'You cannot change your own access');
    }
    this.assertBelowActor(actor, member);

    const userData: Prisma.UserUpdateInput = {};
    const staffData: Prisma.StaffMemberUpdateInput = {};
    const changed: string[] = [];

    if (dto.name !== undefined) {
      userData.name = dto.name;
      changed.push('name');
    }
    if (dto.email !== undefined) {
      const email = dto.email.toLowerCase();
      if (email !== member.user.email) {
        await this.assertLoginFree(email, null, member.userId);
        userData.email = email;
        userData.emailVerifiedAt = new Date();
        changed.push('email');
      }
    }
    if (dto.username !== undefined) {
      const username = this.checkedUsername(dto.username);
      if (username !== member.user.username) {
        await this.assertLoginFree(null, username, member.userId);
        userData.username = username;
        changed.push('username');
      }
    }
    if (dto.title !== undefined) {
      staffData.title = dto.title || null;
      changed.push('title');
    }
    if (dto.permissions !== undefined) {
      const permissions = this.grantable(actor, dto.permissions);
      if (!permissions.length) {
        throw new ApiException(HttpStatus.BAD_REQUEST, 'PERMISSIONS_REQUIRED', 'Pick at least one permission');
      }
      staffData.permissions = permissions;
      changed.push('permissions');
    }
    if (dto.venueIds !== undefined) {
      staffData.venueIds = await this.venuesFor(actor, dto.venueIds);
      changed.push('venues');
    }
    if (dto.status !== undefined) {
      userData.status = dto.status;
      changed.push('status');
    }
    let resetPassword = false;
    if (dto.password) {
      userData.passwordHash = await bcrypt.hash(dto.password, this.config.get<number>('SALT_ROUNDS', 10));
      resetPassword = true;
      changed.push('password');
    }
    if (!changed.length) return this.one(staffId);

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(userData).length) await tx.user.update({ where: { id: member.userId }, data: userData });
      if (Object.keys(staffData).length) await tx.staffMember.update({ where: { id: staffId }, data: staffData });
      // A new password, a suspension or a lost login must end sessions that are already open.
      if (resetPassword || dto.status === 'suspended') {
        await tx.refreshToken.updateMany({
          where: { userId: member.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      // Never log the password itself.
      await this.audit(tx, actor, 'team.member.updated', staffId, { userId: member.userId, changed });
    });
    if (resetPassword || dto.status === 'suspended') this.realtime?.disconnectUser(member.userId);
    return this.one(staffId);
  }

  /**
   * "Delete" keeps the user row (bookings and audit entries point at it) but ends the
   * person's access for good: no permissions, no credentials, no open sessions, and
   * their email / username are freed for reuse.
   */
  async remove(actor: TeamActor, staffId: string) {
    const member = await this.loadMember(actor, staffId);
    if (member.userId === actor.userId) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'CANNOT_EDIT_SELF', 'You cannot remove yourself');
    }
    this.assertBelowActor(actor, member);
    await this.prisma.$transaction(async (tx) => {
      await tx.staffMember.delete({ where: { id: staffId } });
      await tx.user.update({
        where: { id: member.userId },
        data: { status: 'banned', passwordHash: null, email: null, username: null, roles: { set: ['player'] } },
      });
      await tx.refreshToken.updateMany({
        where: { userId: member.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(tx, actor, 'team.member.removed', staffId, {
        userId: member.userId,
        name: member.user.name,
        email: member.user.email,
        username: member.user.username,
      });
    });
    this.realtime?.disconnectUser(member.userId);
    return { ok: true };
  }

  // ---- internals ----------------------------------------------------------

  private async one(staffId: string) {
    const row = await this.prisma.staffMember.findUniqueOrThrow({
      where: { id: staffId },
      include: {
        user: { select: { id: true, name: true, email: true, username: true, status: true, lastSeenAt: true } },
      },
    });
    return {
      id: row.id,
      userId: row.userId,
      name: row.user.name,
      email: row.user.email,
      username: row.user.username,
      title: row.title,
      permissions: row.permissions,
      venueIds: row.venueIds,
      status: row.user.status === 'active' ? 'active' : 'suspended',
      lastSeenAt: row.user.lastSeenAt,
      createdAt: row.createdAt,
      isYou: false,
    };
  }

  private async loadMember(actor: TeamActor, staffId: string) {
    const member = await this.prisma.staffMember.findUnique({
      where: { id: staffId },
      include: { user: { select: { id: true, name: true, email: true, username: true, status: true } } },
    });
    // Another organisation's staff look exactly like a missing one.
    if (!member || member.ownerId !== actor.ownerId) throw new NotFoundException('Team member not found');
    return member;
  }

  /** A delegated manager may only touch people who hold no more than they do. */
  private assertBelowActor(actor: TeamActor, member: { permissions: string[]; venueIds: string[] }) {
    if (actor.kind !== 'staff') return;
    const mine = new Set(actor.scope!.permissions);
    const myVenues = new Set(actor.scope!.venueIds);
    const above =
      member.permissions.some((p) => !mine.has(p)) || member.venueIds.some((v) => !myVenues.has(v));
    if (above) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'ABOVE_YOUR_LEVEL', 'This person has access you do not have');
    }
  }

  /** Clean the requested keys, and stop a delegated manager from handing out what they lack. */
  private grantable(actor: TeamActor, requested: string[]): PermissionKey[] {
    const permissions = normalizePermissions(requested);
    if (actor.kind === 'staff') {
      const mine = new Set(actor.scope!.permissions);
      if (permissions.some((p) => !mine.has(p))) {
        throw new ApiException(HttpStatus.FORBIDDEN, 'CANNOT_GRANT', 'You cannot give permissions you do not have yourself');
      }
    }
    return permissions;
  }

  private async venuesFor(actor: TeamActor, requested?: string[]): Promise<string[]> {
    const owned = await this.prisma.venue.findMany({ where: { ownerId: actor.ownerId }, select: { id: true } });
    const ownedIds = new Set(owned.map((v) => v.id));
    const pool =
      actor.kind === 'staff' ? [...ownedIds].filter((id) => actor.scope!.venueIds.includes(id)) : [...ownedIds];
    const ids = requested === undefined ? pool : [...new Set(requested)];
    if (!ids.length) throw new ApiException(HttpStatus.BAD_REQUEST, 'VENUES_REQUIRED', 'Pick at least one venue');
    if (ids.some((id) => !pool.includes(id))) {
      throw new ForbiddenException('One of those venues is not available to you');
    }
    return ids;
  }

  private checkedUsername(raw: string): string {
    if (!isValidUsername(raw)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'USERNAME_INVALID',
        'Username must start with a letter and be 4–30 letters, digits, dots or underscores',
      );
    }
    return normalizeUsername(raw);
  }

  private async assertLoginFree(email: string | null, username: string | null, exceptUserId?: string) {
    if (email) {
      const hit = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (hit && hit.id !== exceptUserId) {
        throw new ApiException(HttpStatus.CONFLICT, 'EMAIL_TAKEN', 'That email is already used by another account');
      }
    }
    if (username) {
      const hit = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
      if (hit && hit.id !== exceptUserId) {
        throw new ApiException(HttpStatus.CONFLICT, 'USERNAME_TAKEN', 'That username is already taken');
      }
    }
  }

  private audit(
    tx: Prisma.TransactionClient,
    actor: TeamActor,
    action: string,
    staffId: string,
    metadata: Record<string, unknown>,
  ) {
    return tx.auditLogEntry.create({
      data: {
        actorUserId: actor.userId,
        action,
        targetType: 'staff_member',
        targetId: staffId,
        metadata: { ownerId: actor.ownerId, actor: actor.kind, ...metadata } as Prisma.InputJsonValue,
      },
    });
  }
}
