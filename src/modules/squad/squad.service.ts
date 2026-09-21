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
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { NotificationsService } from '../notifications/notifications.service';
import { ApiException } from '../../common/errors/api-exception';
import {
  SQUAD_INVITE_PAUSED_CODE,
  squadInviteHoldUntil,
  squadInviteRetryAfterSec,
} from './squad-invite-hold';

const SQUAD_MAX_SIZE = 7;

/** A shared link stays valid this long; a fresh one is minted on demand after. */
export const SQUAD_LINK_TTL_MS = 24 * 60 * 60 * 1000;
/** Guests are throw-away: idle accounts older than this are deleted. */
export const GUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * A lobby invite is a *ring*, not an inbox item: it is only meaningful while
 * the caller is still sitting in the lobby waiting. Without a lifetime, every
 * `GET /squad/invites` after a reconnect (or after the player reopens the
 * browser hours later) replays invites nobody sent again, which reads to both
 * sides as "he keeps inviting me" / "my phone invited people by itself".
 */
export const SQUAD_INVITE_TTL_MS = 3 * 60 * 1000;

/**
 * How long a member may be off the socket before the lobby drops them. Covers
 * closing the tab, backgrounding the browser on mobile, and short network
 * blips: under the grace period the squad just sees them as reconnecting.
 */
export const SQUAD_DISCONNECT_GRACE_MS = 45 * 1000;

@Injectable()
export class SquadService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SquadService.name);
  /** userId -> pending "drop them from the lobby" timer. */
  private readonly dropTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The lobby follows the socket, not the HTTP session: a closed tab, a
   * backgrounded mobile browser or a dead network must not leave a ghost
   * sitting in a friend's lobby. Under the grace period the squad just sees
   * them as reconnecting; past it they are dropped for real.
   */
  onModuleInit(): void {
    this.presence.connection$.subscribe(({ userId, connected }) => {
      if (connected) {
        this.clearDropTimer(userId);
        void this.broadcastMemberConnection(userId, true).catch(() => undefined);
        return;
      }
      if (this.dropTimers.has(userId)) return;
      void this.broadcastMemberConnection(userId, false).catch(() => undefined);
      const timer = setTimeout(() => {
        this.dropTimers.delete(userId);
        if (this.presence.isReachable(userId, SQUAD_DISCONNECT_GRACE_MS)) return;
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
  }

  private clearDropTimer(userId: string): void {
    const timer = this.dropTimers.get(userId);
    if (!timer) return;
    clearTimeout(timer);
    this.dropTimers.delete(userId);
  }

  /**
   * Safety net for anything the socket lifecycle could not clean up: a server
   * restart drops the in-memory grace timers, so members whose socket never
   * came back would otherwise stay in a lobby indefinitely. Also retires
   * invites nobody answered.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweepStaleLobbies(): Promise<void> {
    await this.expireStaleInvites().catch(() => undefined);
    const stale = new Date(Date.now() - SQUAD_DISCONNECT_GRACE_MS);
    const members = await this.prisma.squadMember.findMany({
      where: { joinedAt: { lt: stale } },
      select: { userId: true, user: { select: { lastSeenAt: true } } },
    });
    for (const member of members) {
      if (this.presence.isReachable(member.userId, SQUAD_DISCONNECT_GRACE_MS)) continue;
      if (this.presence.isOnline(member.userId, member.user.lastSeenAt)) continue;
      await this.leaveCurrentSquad(member.userId).catch(() => undefined);
    }
  }

  /**
   * "Enter lobby" from the navbar: idempotent. Returns the caller's current
   * squad, or opens a solo lobby (caller = leader) when they have none, so the
   * lobby is reachable without first inviting someone.
   */
  async startLobby(userId: string) {
    const existing = await this.prisma.squadMember.findFirst({ where: { userId } });
    if (existing) return { squadId: existing.squadId, created: false };
    const squad = await this.prisma.squad.create({
      data: { members: { create: [{ userId, isLeader: true }] } },
    });
    this.presence.setInSquad(userId, true);
    this.presence.setSquadConnected(userId, true);
    return { squadId: squad.id, created: true };
  }

  // ---------- Private invite link ----------

  private linkTokenFor(linkId: string): string {
    const secret = this.config.get<string>('JWT_ACCESS_SECRET') ?? '';
    const sig = createHmac('sha256', secret)
      .update(`squad-link:${linkId}`)
      .digest('base64url');
    return `${linkId}.${sig}`;
  }

  /** Returns the link id when the token is well-formed and correctly signed. */
  private parseLinkToken(token: string): string | null {
    if (typeof token !== 'string' || token.length > 200) return null;
    const [linkId, sig, extra] = token.split('.');
    if (!linkId || !sig || extra !== undefined) return null;
    const expected = this.linkTokenFor(linkId).split('.')[1]!;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return linkId;
  }

  private async resolveLink(token: string) {
    const linkId = this.parseLinkToken(token);
    // One indistinguishable answer for forged, unknown, revoked and expired
    // tokens so the endpoint cannot be used to probe for valid links.
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

  /** Any member can share the lobby; the link is created on first request. */
  async getOrCreateInviteLink(userId: string) {
    let membership = await this.prisma.squadMember.findFirst({
      where: { userId },
    });
    if (!membership) {
      const squad = await this.prisma.squad.create({
        data: { members: { create: [{ userId, isLeader: true }] } },
        include: { members: true },
      });
      this.presence.setInSquad(userId, true);
      membership = squad.members[0]!;
    }
    const squadId = membership.squadId;
    const existing = await this.prisma.squadInviteLink.findUnique({
      where: { squadId },
    });
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      return { token: this.linkTokenFor(existing.id), expiresAt: existing.expiresAt };
    }
    // Expired or missing: replace atomically so two tabs racing cannot leave
    // two live links behind (squadId is unique).
    const expiresAt = new Date(Date.now() + SQUAD_LINK_TTL_MS);
    await this.prisma.squadInviteLink
      .deleteMany({ where: { squadId } })
      .catch(() => undefined);
    const link = await this.prisma.squadInviteLink
      .create({ data: { squadId, createdById: userId, expiresAt } })
      .catch(async () => {
        // Lost the race to a concurrent create: use the winner.
        const winner = await this.prisma.squadInviteLink.findUnique({ where: { squadId } });
        if (!winner) throw new BadRequestException('Could not create the link');
        return winner;
      });
    return { token: this.linkTokenFor(link.id), expiresAt: link.expiresAt };
  }

  /** Leader-only: kills the current link and returns a brand new one. */
  async rotateInviteLink(userId: string) {
    const membership = await this.prisma.squadMember.findFirst({ where: { userId } });
    if (!membership) throw new NotFoundException('Not in a squad');
    if (!membership.isLeader)
      throw new ForbiddenException('Only the squad leader can reset the link');
    await this.prisma.squadInviteLink.deleteMany({ where: { squadId: membership.squadId } });
    return this.getOrCreateInviteLink(userId);
  }

  /** Public, minimal: enough for the landing page, nothing sensitive. */
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
    const leader = members.find((m) => m.isLeader) ?? members[0]!;
    return {
      leaderName: leader.user.name,
      memberCount: members.length,
      maxSize: SQUAD_MAX_SIZE,
      full: members.length >= SQUAD_MAX_SIZE,
    };
  }

  /** Same locked seat-claim as accepting a friend invite, driven by a link. */
  async joinViaInviteLink(userId: string, token: string) {
    const link = await this.resolveLink(token);
    const squadId = link.squadId;

    const existing = await this.prisma.squadMember.findFirst({ where: { userId } });
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
        throw new ApiException(HttpStatus.CONFLICT, 'SQUAD_FULL', 'Squad is full');
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

  /** Guests are disposable: delete idle ones together with their tokens. */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepGuests(): Promise<void> {
    const cutoff = new Date(Date.now() - GUEST_RETENTION_MS);
    const stale = await this.prisma.user.findMany({
      where: {
        isGuest: true,
        createdAt: { lt: cutoff },
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }],
        squadMemberships: { none: {} },
      },
      select: { id: true },
      take: 200,
    });
    for (const g of stale) {
      await this.prisma.user.delete({ where: { id: g.id } }).catch(() => undefined);
    }
    await this.prisma.squadInviteLink
      .deleteMany({ where: { expiresAt: { lt: cutoff } } })
      .catch(() => undefined);
  }

  iceServers() {
    const stun =
      this.config.get<string>('STUN_URLS') ??
      'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';
    const servers: { urls: string; username?: string; credential?: string }[] =
      stun.split(',').map((urls) => urls.trim()).filter(Boolean).map((urls) => ({ urls }));
    const turn = this.config.get<string>('TURN_URLS');
    if (turn) {
      const username = this.config.get<string>('TURN_USERNAME') ?? undefined;
      const credential = this.config.get<string>('TURN_CREDENTIAL') ?? undefined;
      for (const urls of turn.split(',').map((u) => u.trim()).filter(Boolean)) {
        servers.push({ urls, username, credential });
      }
    }
    return { iceServers: servers };
  }

  private inviteFreshSince(): Date {
    return new Date(Date.now() - SQUAD_INVITE_TTL_MS);
  }

  /** Flips pending invites that outlived their ring window to `expired`. */
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
        fromUser: { select: { id: true, name: true, avatarUrl: true, avatarConfig: true } },
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

  /**
   * The squad as the client should render it, including who is currently
   * reachable on a socket — a member whose tab is closed must not look like a
   * silent participant.
   */
  async mySquad(userId: string) {
    // Reading your own lobby is proof the app is alive even if the websocket
    // is having a bad time behind a proxy — without this a flapping socket
    // would evict a player who is sitting right there looking at the lobby.
    if (this.presence.touch(userId)) {
      await this.prisma.user
        .update({ where: { id: userId }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
    }
    const squad = await this.loadSquad(userId);
    if (!squad) return null;
    return {
      ...squad,
      members: squad.members.map((m) => ({
        ...m,
        connected: this.presence.isSquadConnected(m.userId),
      })),
    };
  }

  private async loadSquad(userId: string) {
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

    // A still-ringing invite is returned as-is and deliberately NOT re-emitted:
    // re-emitting made an impatient second tap ring the invitee a second time.
    // A ring that already timed out is retired first so this call can send a
    // genuinely new one.
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
      // Switching squads has to go through leave(), not a bare member delete:
      // deleting a leader's row directly strands their old squad with members
      // and no leader, so nobody can ever invite, kick or approve in it again.
      const existingMembership = await this.prisma.squadMember.findFirst({
        where: { userId },
      });
      if (existingMembership && existingMembership.squadId === invite.squadId)
        throw new BadRequestException('Already in this squad');
      if (existingMembership)
        await this.leave(userId, existingMembership.squadId);

      // Seat check, seat claim and marking the invite used are one atomic step.
      // Otherwise N pending invites all pass a stale count and overflow the
      // lobby — and a failure here would leave the invite "accepted" for a
      // squad the player never actually got into, with no way to retry.
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
      // Every other lobby ringing this player is now moot — leaving them
      // pending is what made a second toast pop straight after joining.
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

    // A member suggested this player; the leader has now agreed to ask them.
    // That is still only half the consent — the player themselves never asked
    // for any of this, so they get a normal invite to accept or decline rather
    // than being dropped straight into a live voice lobby.
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
  }

  async makeLeader(leaderId: string, squadId: string, userId: string) {
    await this.requireLeaderOrThrow(squadId, leaderId);
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
      const next = await this.prisma.squadMember.findFirst({
        where: { squadId, userId: { not: userId } },
      });
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

    // Pending rings that only made sense while this player was in the lobby
    // die with the membership — otherwise they ring on their next visit.
    await this.prisma.squadInvite.updateMany({
      where: { squadId, OR: [{ fromUserId: userId }, { toUserId: userId }], status: 'pending' },
      data: { status: 'expired' },
    });

    const remaining = await this.prisma.squadMember.count({
      where: { squadId },
    });
    if (remaining === 0) {
      await this.prisma.squad.delete({ where: { id: squadId } });
      return;
    }
    this.emitter.emitToRoom(`squad:${squadId}`, {
      type: 'squad.member.left',
      squadId,
      userId,
    });
    this.emitter.revokeRoomAccess(userId, `squad:${squadId}`);
  }

  /**
   * Drops a player out of whatever lobby they are in, without needing them to
   * ask. Used when the socket stays gone past the grace period and on logout,
   * so a closed tab cannot leave a ghost sitting in a friend's lobby forever.
   */
  async leaveCurrentSquad(userId: string): Promise<void> {
    const membership = await this.prisma.squadMember.findFirst({
      where: { userId },
      select: { squadId: true },
    });
    if (!membership) return;
    await this.leave(userId, membership.squadId).catch(() => undefined);
  }

  /**
   * Tells the rest of the lobby that a member's socket went away (or came
   * back) so the UI can show "reconnecting…" instead of a silent avatar that
   * is really a closed tab.
   */
  async broadcastMemberConnection(userId: string, connected: boolean): Promise<void> {
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
