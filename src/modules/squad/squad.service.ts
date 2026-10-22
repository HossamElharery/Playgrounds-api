import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Subject } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { NotificationsService } from '../notifications/notifications.service';
import { ApiException } from '../../common/errors/api-exception';
import { CLASSIC_MORPH_ID } from '../morphs/morph-catalog';
import { lobbyMorphsEnabled } from '../morphs/morphs-flag';
import {
  SQUAD_INVITE_PAUSED_CODE,
  squadInviteHoldUntil,
  squadInviteRetryAfterSec,
} from './squad-invite-hold';

const SQUAD_MAX_SIZE = 7;

export interface SquadMembershipEnded {
  squadId: string;
  userId: string;
  squadEmptied: boolean;
}

export const SQUAD_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const GUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

export const SQUAD_INVITE_TTL_MS = 3 * 60 * 1000;

export const SQUAD_DISCONNECT_GRACE_MS = 45 * 1000;

const TURN_DEFAULT_TTL_S = 12 * 60 * 60;

@Injectable()
export class SquadService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SquadService.name);
  private readonly dropTimers = new Map<string, NodeJS.Timeout>();
  readonly membershipEnded$ = new Subject<SquadMembershipEnded>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.presence.connection$.subscribe(({ userId, connected }) => {
      if (connected) {
        this.clearDropTimer(userId);
        void this.broadcastMemberConnection(userId, true).catch(
          () => undefined,
        );
        return;
      }
      if (this.dropTimers.has(userId)) return;
      void this.broadcastMemberConnection(userId, false).catch(() => undefined);
      const timer = setTimeout(() => {
        this.dropTimers.delete(userId);
        if (this.presence.isReachable(userId, SQUAD_DISCONNECT_GRACE_MS))
          return;
        void this.leaveCurrentSquad(userId).catch((err) => {
          this.logger.warn(
            `squad auto-leave failed: ${err instanceof Error ? err.message : err}`,
          );
        });
      }, SQUAD_DISCONNECT_GRACE_MS);
      timer.unref?.();
      this.dropTimers.set(userId, timer);
    });
  }

  onModuleDestroy(): void {
    for (const timer of this.dropTimers.values()) clearTimeout(timer);
    this.dropTimers.clear();
    this.membershipEnded$.complete();
  }

  private clearDropTimer(userId: string): void {
    const timer = this.dropTimers.get(userId);
    if (!timer) return;
    clearTimeout(timer);
    this.dropTimers.delete(userId);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweepStaleLobbies(): Promise<void> {
    await this.expireStaleInvites().catch(() => undefined);
    const stale = new Date(Date.now() - SQUAD_DISCONNECT_GRACE_MS);
    const members = await this.prisma.squadMember.findMany({
      where: { joinedAt: { lt: stale } },
      select: { userId: true, user: { select: { lastSeenAt: true } } },
    });
    for (const member of members) {
      if (this.presence.isReachable(member.userId, SQUAD_DISCONNECT_GRACE_MS))
        continue;
      if (this.presence.isOnline(member.userId, member.user.lastSeenAt))
        continue;
      await this.leaveCurrentSquad(member.userId).catch(() => undefined);
    }
  }

  async startLobby(userId: string) {
    const existing = await this.prisma.squadMember.findFirst({
      where: { userId },
    });
    if (existing) return { squadId: existing.squadId, created: false };
    const squad = await this.prisma.squad.create({
      data: { members: { create: [{ userId, isLeader: true }] } },
    });
    this.presence.setInSquad(userId, true);
    this.presence.setSquadConnected(userId, true);
    return { squadId: squad.id, created: true };
  }


  private linkTokenFor(linkId: string): string {
    const secret = this.config.get<string>('JWT_ACCESS_SECRET') ?? '';
    const sig = createHmac('sha256', secret)
      .update(`squad-link:${linkId}`)
      .digest('base64url');
    return `${linkId}.${sig}`;
  }

  private parseLinkToken(token: string): string | null {
    if (typeof token !== 'string' || token.length > 200) return null;
    const [linkId, sig, extra] = token.split('.');
    if (!linkId || !sig || extra !== undefined) return null;
    const expected = this.linkTokenFor(linkId).split('.')[1];
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return linkId;
  }

  private async resolveLink(token: string) {
    const linkId = this.parseLinkToken(token);
    const gone = () =>
      new ApiException(
        HttpStatus.NOT_FOUND,
        'SQUAD_LINK_INVALID',
        'This invite link is no longer valid',
      );
    if (!linkId) throw gone();
    const link = await this.prisma.squadInviteLink.findUnique({
      where: { id: linkId },
    });
    if (!link || link.expiresAt.getTime() <= Date.now()) throw gone();
    return link;
  }

  async getOrCreateInviteLink(userId: string) {
    const membership = await this.prisma.squadMember.findFirst({
      where: { userId },
    });
    if (!membership) throw new NotFoundException('Not in a squad');
    const squadId = membership.squadId;
    const existing = await this.prisma.squadInviteLink.findUnique({
      where: { squadId },
    });
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      return {
        token: this.linkTokenFor(existing.id),
        expiresAt: existing.expiresAt,
      };
    }
    const expiresAt = new Date(Date.now() + SQUAD_LINK_TTL_MS);
    const link = await this.prisma.squadInviteLink.upsert({
      where: { squadId },
      create: { squadId, createdById: userId, expiresAt },
      update: { expiresAt, createdById: userId },
    });
    return { token: this.linkTokenFor(link.id), expiresAt: link.expiresAt };
  }

  async rotateInviteLink(userId: string) {
    const membership = await this.prisma.squadMember.findFirst({
      where: { userId },
    });
    if (!membership) throw new NotFoundException('Not in a squad');
    if (!membership.isLeader)
      throw new ForbiddenException('Only the squad leader can reset the link');
    const newId = randomUUID();
    const expiresAt = new Date(Date.now() + SQUAD_LINK_TTL_MS);
    const link = await this.prisma.squadInviteLink.upsert({
      where: { squadId: membership.squadId },
      create: {
        id: newId,
        squadId: membership.squadId,
        createdById: userId,
        expiresAt,
      },
      update: { id: newId, createdById: userId, expiresAt },
    });
    return { token: this.linkTokenFor(link.id), expiresAt: link.expiresAt };
  }

  async previewInviteLink(token: string) {
    const link = await this.resolveLink(token);
    const members = await this.prisma.squadMember.findMany({
      where: { squadId: link.squadId },
      select: { isLeader: true, user: { select: { name: true } } },
    });
    if (members.length === 0) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'SQUAD_LINK_INVALID',
        'This invite link is no longer valid',
      );
    }
    const leader = members.find((m) => m.isLeader) ?? members[0];
    return {
      leaderName: leader.user.name,
      memberCount: members.length,
      maxSize: SQUAD_MAX_SIZE,
      full: members.length >= SQUAD_MAX_SIZE,
    };
  }

  async joinViaInviteLink(userId: string, token: string) {
    const link = await this.resolveLink(token);
    const squadId = link.squadId;

    const existing = await this.prisma.squadMember.findFirst({
      where: { userId },
    });
    if (existing?.squadId === squadId) return { squadId, alreadyMember: true };
    if (existing) await this.leave(userId, existing.squadId);

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Squad" WHERE "id" = ${squadId} FOR UPDATE`;
      const squad = await tx.squad.findUnique({ where: { id: squadId } });
      if (!squad)
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          'SQUAD_LINK_INVALID',
          'This invite link is no longer valid',
        );
      const size = await tx.squadMember.count({ where: { squadId } });
      if (size >= SQUAD_MAX_SIZE)
        throw new ApiException(
          HttpStatus.CONFLICT,
          'SQUAD_FULL',
          'Squad is full',
        );
      await tx.squadMember.create({ data: { squadId, userId } });
    });
    this.presence.setInSquad(userId, true);
    this.presence.setSquadConnected(userId, true);
    await this.prisma.squadInvite.updateMany({
      where: { toUserId: userId, status: 'pending' },
      data: { status: 'expired' },
    });
    await this.prisma.squadJoinRequest.updateMany({
      where: { fromUserId: userId, status: 'pending' },
      data: { status: 'expired' },
    });
    this.emitter.emitToRoom(`squad:${squadId}`, {
      type: 'squad.member.joined',
      squadId,
      userId,
    });
    return { squadId, alreadyMember: false };
  }

  async accountCompleted(userId: string): Promise<void> {
    const member = await this.prisma.squadMember.findFirst({ where: { userId }, select: { squadId: true } });
    if (member) this.emitter.emitToRoom(`squad:${member.squadId}`, {
      type: 'squad.member.updated', squadId: member.squadId, userId,
    });
  }

  @Cron(CronExpression.EVERY_HOUR)
  async sweepGuests(): Promise<void> {
    const cutoff = new Date(Date.now() - GUEST_RETENTION_MS);
    const stale = await this.prisma.user.findMany({
      where: {
        isGuest: true,
        // camo_play guests are swept by the camo job (30 days, only when unconverted and without bookings)
        AND: [{ OR: [{ guestSource: null }, { guestSource: { not: 'camo_play' } }] }],
        createdAt: { lt: cutoff },
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }],
        squadMemberships: { none: {} },
      },
      select: { id: true },
      take: 200,
    });
    for (const g of stale) {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${g.id} FOR UPDATE`;
        const current = await tx.user.findFirst({
          where: { id: g.id, isGuest: true, AND: [{ OR: [{ guestSource: null }, { guestSource: { not: 'camo_play' } }] }], createdAt: { lt: cutoff }, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }], squadMemberships: { none: {} } },
        });
        if (!current) return;
        await tx.friendship.deleteMany({
          where: { OR: [{ requesterId: g.id }, { addresseeId: g.id }] },
        });
        await tx.user.delete({ where: { id: g.id, isGuest: true } });
      }).catch(() => undefined);
    }
    await this.prisma.squadInviteLink
      .deleteMany({ where: { expiresAt: { lt: cutoff } } })
      .catch(() => undefined);
  }

  iceServers(userId?: string): {
    iceServers: { urls: string; username?: string; credential?: string }[];
    iceTransportPolicy?: 'relay';
  } {
    const stun =
      this.config.get<string>('STUN_URLS') ??
      'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';
    const servers: { urls: string; username?: string; credential?: string }[] =
      stun
        .split(',')
        .map((urls) => urls.trim())
        .filter(Boolean)
        .map((urls) => ({ urls }));
    const turn = this.config.get<string>('TURN_URLS');
    if (turn) {
      const { username, credential } = this.turnCredentials(userId);
      for (const urls of turn
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean)) {
        servers.push({ urls, username, credential });
      }
      if (this.config.get<string>('TURN_FORCE_RELAY') === 'true') {
        return { iceServers: servers, iceTransportPolicy: 'relay' };
      }
    }
    return { iceServers: servers };
  }

  private turnCredentials(userId?: string): {
    username?: string;
    credential?: string;
  } {
    const secret = this.config.get<string>('TURN_SECRET');
    if (secret) {
      const ttl = Number(this.config.get<string>('TURN_TTL_SECONDS'));
      const ttlSeconds =
        Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : TURN_DEFAULT_TTL_S;
      const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
      const username = `${expiry}:${userId ?? 'guest'}`;
      const credential = createHmac('sha1', secret)
        .update(username)
        .digest('base64');
      return { username, credential };
    }
    return {
      username: this.config.get<string>('TURN_USERNAME') || undefined,
      credential: this.config.get<string>('TURN_CREDENTIAL') || undefined,
    };
  }

  private inviteFreshSince(): Date {
    return new Date(Date.now() - SQUAD_INVITE_TTL_MS);
  }

  async expireStaleInvites(toUserId?: string): Promise<void> {
    await this.prisma.squadInvite.updateMany({
      where: {
        status: 'pending',
        createdAt: { lt: this.inviteFreshSince() },
        ...(toUserId ? { toUserId } : {}),
      },
      data: { status: 'expired' },
    });
  }

  async incomingInvites(userId: string) {
    await this.expireStaleInvites(userId);
    return this.prisma.squadInvite.findMany({
      where: {
        toUserId: userId,
        status: 'pending',
        createdAt: { gte: this.inviteFreshSince() },
      },
      include: {
        fromUser: {
          select: { id: true, name: true, avatarUrl: true, avatarConfig: true },
        },
        squad: { include: { members: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  joinRequests(leaderId: string, squadId: string) {
    return this.requireLeaderOrThrow(squadId, leaderId).then(() =>
      this.prisma.squadJoinRequest.findMany({
        where: { squadId, status: 'pending' },
        include: {
          fromUser: { select: { id: true, name: true, avatarUrl: true } },
        },
      }),
    );
  }

  async mySquad(userId: string) {
    if (this.presence.touch(userId)) {
      await this.prisma.user
        .update({ where: { id: userId }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
    }
    const morphs = lobbyMorphsEnabled(this.config);
    const squad = await this.loadSquad(userId, morphs);
    if (!squad) return null;
    return {
      ...squad,
      members: squad.members.map((m) => ({
        ...m,
        connected: this.presence.isSquadConnected(m.userId),
        // Lobby Morphs: older clients ignore the extra field.
        ...(morphs
          ? {
              morphId: m.user.morphProfile?.equippedMorphId ?? CLASSIC_MORPH_ID,
            }
          : {}),
      })),
    };
  }

  private async loadSquad(userId: string, withMorphs = false) {
    const membership = await this.prisma.squadMember.findFirst({
      where: { userId },
      include: {
        squad: {
          include: {
            members: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    avatarUrl: true,
                    avatarConfig: true,
                    isGuest: true,
                    ...(withMorphs
                      ? { morphProfile: { select: { equippedMorphId: true } } }
                      : {}),
                  },
                },
              },
            },
          },
        },
      },
    });
    return membership?.squad ?? null;
  }

  private async requireLeaderOrThrow(squadId: string, userId: string) {
    const member = await this.prisma.squadMember.findUnique({
      where: { squadId_userId: { squadId, userId } },
    });
    if (!member?.isLeader)
      throw new ForbiddenException('Only the squad leader can do this');
    return member;
  }

  async invite(fromUserId: string, toUserId: string) {
    if (fromUserId === toUserId)
      throw new BadRequestException('Cannot invite yourself');

    await this.assertInviteNotHeld(toUserId, fromUserId);

    const membership = await this.prisma.squadMember.findFirst({
      where: { userId: fromUserId },
    });
    let squadId: string;

    if (!membership) {
      const squad = await this.prisma.squad.create({
        data: { members: { create: [{ userId: fromUserId, isLeader: true }] } },
      });
      squadId = squad.id;
      this.presence.setInSquad(fromUserId, true);
    } else {
      squadId = membership.squadId;
    }

    const size = await this.prisma.squadMember.count({ where: { squadId } });
    if (size >= SQUAD_MAX_SIZE) throw new BadRequestException('Squad is full');

    const isLeader = membership?.isLeader ?? true;
    if (!isLeader) {
      const leader = await this.prisma.squadMember.findFirst({
        where: { squadId, isLeader: true },
      });
      if (leader) await this.assertInviteNotHeld(leader.userId, toUserId);

      const existingRequest = await this.prisma.squadJoinRequest.findFirst({
        where: { squadId, fromUserId: toUserId, status: 'pending' },
      });
      if (existingRequest) return existingRequest;
      const request = await this.prisma.squadJoinRequest.create({
        data: { squadId, fromUserId: toUserId, viaMemberId: membership!.id },
      });
      if (leader)
        this.emitter.emitToUser(leader.userId, {
          type: 'squad.join_request.created',
          request,
        });
      return request;
    }

    await this.expireStaleInvites(toUserId);
    const existingInvite = await this.prisma.squadInvite.findFirst({
      where: {
        squadId,
        fromUserId,
        toUserId,
        status: 'pending',
        createdAt: { gte: this.inviteFreshSince() },
      },
    });
    if (existingInvite) return existingInvite;

    const invite = await this.prisma.squadInvite.create({
      data: { squadId, fromUserId, toUserId },
    });
    this.emitter.emitToUser(toUserId, { type: 'squad.invite.created', invite });
    const from = await this.prisma.user.findUnique({
      where: { id: fromUserId },
      select: { name: true },
    });
    await this.notifications.create({
      userId: toUserId,
      category: 'squad',
      titleEn: `${from?.name ?? 'A player'} invited you to a squad`,
      titleAr: `${from?.name ?? 'لاعب'} دعاك إلى سكواد`,
      deepLink: `/app`,
      payload: { inviteId: invite.id, squadId },
    });
    return invite;
  }

  async respondInvite(
    userId: string,
    inviteId: string,
    accept: boolean,
    hold = false,
  ) {
    const invite = await this.prisma.squadInvite.findUnique({
      where: { id: inviteId },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.toUserId !== userId)
      throw new ForbiddenException('Not your invite');
    if (invite.status !== 'pending')
      throw new BadRequestException('Already resolved');

    if (accept) {
      const existingMembership = await this.prisma.squadMember.findFirst({
        where: { userId },
      });
      if (existingMembership && existingMembership.squadId === invite.squadId)
        throw new BadRequestException('Already in this squad');
      if (existingMembership)
        await this.leave(userId, existingMembership.squadId);

      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "Squad" WHERE "id" = ${invite.squadId} FOR UPDATE`;
        const squad = await tx.squad.findUnique({
          where: { id: invite.squadId },
        });
        if (!squad) throw new NotFoundException('Squad no longer exists');
        const size = await tx.squadMember.count({
          where: { squadId: invite.squadId },
        });
        if (size >= SQUAD_MAX_SIZE)
          throw new BadRequestException('Squad is full');
        await tx.squadMember.create({
          data: { squadId: invite.squadId, userId },
        });
        await tx.squadInvite.update({
          where: { id: inviteId },
          data: { status: 'accepted' },
        });
      });
      this.presence.setInSquad(userId, true);
      await this.prisma.squadInvite.updateMany({
        where: { toUserId: userId, status: 'pending' },
        data: { status: 'expired' },
      });
      await this.prisma.squadJoinRequest.updateMany({
        where: { fromUserId: userId, status: 'pending' },
        data: { status: 'expired' },
      });
    } else {
      await this.prisma.squadInvite.update({
        where: { id: inviteId },
        data: { status: 'declined' },
      });
      if (hold) await this.placeInviteHold(userId, invite.fromUserId);
    }

    this.emitter.emitToUser(invite.fromUserId, {
      type: 'squad.invite.resolved',
      inviteId,
      status: accept ? 'accepted' : 'declined',
    });
    return { accepted: accept };
  }

  async resolveJoinRequest(
    leaderId: string,
    requestId: string,
    approve: boolean,
    hold = false,
  ) {
    const request = await this.prisma.squadJoinRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException('Request not found');
    await this.requireLeaderOrThrow(request.squadId, leaderId);

    if (request.status !== 'pending')
      throw new BadRequestException('Request already resolved');

    if (approve) await this.assertInviteNotHeld(request.fromUserId, leaderId);

    await this.prisma.squadJoinRequest.update({
      where: { id: requestId },
      data: {
        status: approve ? 'accepted' : 'declined',
        resolvedByUserId: leaderId,
      },
    });

    if (!approve) {
      if (hold) await this.placeInviteHold(leaderId, request.fromUserId);
      this.emitter.emitToUser(request.fromUserId, {
        type: 'squad.join_request.resolved',
        requestId,
        status: 'declined',
      });
      return { approved: false, invited: false };
    }

    const existingInvite = await this.prisma.squadInvite.findFirst({
      where: {
        squadId: request.squadId,
        toUserId: request.fromUserId,
        status: 'pending',
      },
    });
    const invite =
      existingInvite ??
      (await this.prisma.squadInvite.create({
        data: {
          squadId: request.squadId,
          fromUserId: leaderId,
          toUserId: request.fromUserId,
        },
      }));
    this.emitter.emitToUser(request.fromUserId, {
      type: 'squad.invite.created',
      invite,
    });
    if (!existingInvite) {
      const leader = await this.prisma.user.findUnique({
        where: { id: leaderId },
        select: { name: true },
      });
      await this.notifications
        .create({
          userId: request.fromUserId,
          category: 'squad',
          titleEn: `${leader?.name ?? 'A player'} invited you to a squad`,
          titleAr: `${leader?.name ?? 'لاعب'} دعاك إلى سكواد`,
          deepLink: '/app',
          payload: { inviteId: invite.id, squadId: request.squadId },
        })
        .catch(() => undefined);
    }
    return { approved: true, invited: true };
  }

  async kick(leaderId: string, squadId: string, userId: string) {
    await this.requireLeaderOrThrow(squadId, leaderId);
    if (userId === leaderId)
      throw new BadRequestException(
        'Leader cannot kick themselves — use leave or transfer leadership',
      );
    await this.prisma.squadMember.delete({
      where: { squadId_userId: { squadId, userId } },
    });
    this.presence.setInSquad(userId, false);
    this.emitter.emitToRoom(`squad:${squadId}`, {
      type: 'squad.member.kicked',
      squadId,
      userId,
    });
    this.emitter.revokeRoomAccess(userId, `squad:${squadId}`);
    this.membershipEnded$.next({ squadId, userId, squadEmptied: false });
  }

  async makeLeader(leaderId: string, squadId: string, userId: string) {
    await this.requireLeaderOrThrow(squadId, leaderId);
    const target = await this.prisma.squadMember.findUnique({
      where: { squadId_userId: { squadId, userId } },
      include: { user: { select: { isGuest: true } } },
    });
    if (!target) throw new NotFoundException('Not a member of this squad');
    if (target.user.isGuest)
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'GUEST_CANNOT_LEAD',
        'Guests cannot be made squad leader',
      );
    await this.prisma.$transaction([
      this.prisma.squadMember.update({
        where: { squadId_userId: { squadId, userId: leaderId } },
        data: { isLeader: false },
      }),
      this.prisma.squadMember.update({
        where: { squadId_userId: { squadId, userId } },
        data: { isLeader: true },
      }),
    ]);
    this.emitter.emitToRoom(`squad:${squadId}`, {
      type: 'squad.leader.changed',
      squadId,
      userId,
    });
  }

  async setMemberMuted(
    leaderId: string,
    squadId: string,
    userId: string,
    muted: boolean,
  ) {
    await this.requireLeaderOrThrow(squadId, leaderId);
    await this.prisma.squadMember.update({
      where: { squadId_userId: { squadId, userId } },
      data: { micMuted: muted },
    });
    this.emitter.emitToRoom(`squad:${squadId}`, {
      type: 'squad.member.muted',
      squadId,
      userId,
      muted,
    });
  }

  async toggleOwnMic(userId: string, squadId: string, muted: boolean) {
    await this.prisma.squadMember.update({
      where: { squadId_userId: { squadId, userId } },
      data: { micMuted: muted },
    });
    this.emitter.emitToRoom(`squad:${squadId}`, {
      type: 'squad.member.muted',
      squadId,
      userId,
      muted,
    });
  }

  async leave(userId: string, squadId: string) {
    const member = await this.prisma.squadMember.findUnique({
      where: { squadId_userId: { squadId, userId } },
    });
    if (!member) throw new NotFoundException('Not a member of this squad');

    if (member.isLeader) {
      const next =
        (await this.prisma.squadMember.findFirst({
          where: { squadId, userId: { not: userId }, user: { isGuest: false } },
        })) ??
        (await this.prisma.squadMember.findFirst({
          where: { squadId, userId: { not: userId } },
        }));
      if (next) {
        await this.prisma.squadMember.update({
          where: { id: next.id },
          data: { isLeader: true },
        });
      }
    }
    await this.prisma.squadMember.delete({ where: { id: member.id } });
    this.presence.setInSquad(userId, false);
    this.presence.setSquadConnected(userId, true);

    await this.prisma.squadInvite.updateMany({
      where: {
        squadId,
        OR: [{ fromUserId: userId }, { toUserId: userId }],
        status: 'pending',
      },
      data: { status: 'expired' },
    });

    const remaining = await this.prisma.squadMember.count({
      where: { squadId },
    });
    if (remaining === 0) {
      await this.prisma.squad.delete({ where: { id: squadId } });
      this.membershipEnded$.next({ squadId, userId, squadEmptied: true });
      return;
    }
    this.emitter.emitToRoom(`squad:${squadId}`, {
      type: 'squad.member.left',
      squadId,
      userId,
    });
    this.emitter.revokeRoomAccess(userId, `squad:${squadId}`);
    this.membershipEnded$.next({ squadId, userId, squadEmptied: false });
  }

  async leaveCurrentSquad(userId: string): Promise<void> {
    const membership = await this.prisma.squadMember.findFirst({
      where: { userId },
      select: { squadId: true },
    });
    if (!membership) return;
    await this.leave(userId, membership.squadId).catch(() => undefined);
  }

  async broadcastMemberConnection(
    userId: string,
    connected: boolean,
  ): Promise<void> {
    const membership = await this.prisma.squadMember.findFirst({
      where: { userId },
      select: { squadId: true },
    });
    if (!membership) return;
    this.presence.setSquadConnected(userId, connected);
    this.emitter.emitToRoom(`squad:${membership.squadId}`, {
      type: 'squad.member.connection',
      squadId: membership.squadId,
      userId,
      connected,
    });
  }

  private async assertInviteNotHeld(holderId: string, fromUserId: string) {
    const hold = await this.prisma.squadInviteHold.findUnique({
      where: { holderId_fromUserId: { holderId, fromUserId } },
    });
    if (!hold) return;
    if (hold.until.getTime() <= Date.now()) {
      await this.prisma.squadInviteHold
        .delete({ where: { id: hold.id } })
        .catch(() => undefined);
      return;
    }
    throw new ApiException(
      HttpStatus.FORBIDDEN,
      SQUAD_INVITE_PAUSED_CODE,
      'This player is not accepting squad invites right now',
      { retryAfterSec: squadInviteRetryAfterSec(hold.until) },
    );
  }

  private async placeInviteHold(holderId: string, fromUserId: string) {
    if (holderId === fromUserId) return;
    const until = squadInviteHoldUntil();
    await this.prisma.squadInviteHold.upsert({
      where: { holderId_fromUserId: { holderId, fromUserId } },
      create: { holderId, fromUserId, until },
      update: { until },
    });
    await this.prisma.squadInvite.updateMany({
      where: { fromUserId, toUserId: holderId, status: 'pending' },
      data: { status: 'declined' },
    });
    await this.prisma.squadJoinRequest.updateMany({
      where: {
        fromUserId,
        status: 'pending',
        squad: { members: { some: { userId: holderId, isLeader: true } } },
      },
      data: { status: 'declined', resolvedByUserId: holderId },
    });
  }
}
