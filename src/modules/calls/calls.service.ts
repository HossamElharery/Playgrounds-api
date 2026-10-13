import {
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StaffCall, StaffCallStatus } from '@prisma/client';
import { Subscription } from 'rxjs';
import { ApiException } from '../../common/errors/api-exception';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { NotificationsService } from '../notifications/notifications.service';
import { FcmService } from '../notifications/fcm.service';
import { WebPushService } from '../notifications/web-push.service';
import { SquadService } from '../squad/squad.service';
import {
  CALL_DISCONNECT_GRACE_MS,
  CALL_MAX_DURATION_MS,
  CALL_PUSH_DELAY_MS,
  CALL_RETENTION_DAYS,
  CALL_RING_MS,
  CALL_SWEEP_EVERY_MS,
  MAX_MUTE_MINUTES,
} from './calls.constants';
import { staffCallsEnabled } from './calls-flag';

export interface CallPeer {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: 'owner' | 'staff';
  title: string | null;
}

export interface DirectoryMember extends CallPeer {
  online: boolean;
  /** In another call right now. */
  busy: boolean;
  /** I muted this person's calls until then (they are never told). */
  mutedUntil: string | null;
}

export interface CallDirectory {
  enabled: boolean;
  members: DirectoryMember[];
  dndUntil: string | null;
  missedUnseen: number;
}

export interface CallView {
  id: string;
  status: StaffCallStatus;
  direction: 'in' | 'out';
  peer: CallPeer;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  /** Ringing calls only: when the call stops ringing by itself. */
  expiresAt: string | null;
  /** Incoming missed/cancelled call the user has not opened yet. */
  unseen: boolean;
}

/** In-memory mirror of a call that is ringing or in progress (the database row stays the truth). */
interface LiveCall {
  id: string;
  ownerId: string;
  callerId: string;
  calleeId: string;
  status: 'ringing' | 'answered';
  /** A push (FCM / web) was sent for this ring, so a replacement is owed when it ends. */
  pushed: boolean;
  /** The callee's device confirmed it is ringing, per kind. */
  ackNative: boolean;
  ackWeb: boolean;
  ringingEmitted: boolean;
}

const ACTIVE_STATUSES: StaffCallStatus[] = ['ringing', 'answered'];

/**
 * Owner <-> team voice calls (1:1). This service is the single source of truth for who may call whom
 * (same organisation only), the call state machine, mutes / do-not-disturb, and when a phone is
 * pushed. The audio itself is peer-to-peer WebRTC; the gateway only relays SDP/ICE between the two
 * parties of an answered call.
 */
@Injectable()
export class CallsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallsService.name);
  private readonly live = new Map<string, LiveCall>();
  private readonly ringTimers = new Map<string, NodeJS.Timeout>();
  private readonly pushTimers = new Map<string, NodeJS.Timeout>();
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private connectionSub: Subscription | null = null;
  /** Calls are rare; creating them one at a time makes "both call each other at once" impossible. */
  private createChain: Promise<unknown> = Promise.resolve();
  private lastRetentionRun = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly presence: PresenceService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly notifications: NotificationsService,
    private readonly fcm: FcmService,
    private readonly webPush: WebPushService,
    private readonly squad: SquadService,
  ) {}

  onModuleInit(): void {
    this.connectionSub = this.presence.connection$.subscribe(
      ({ userId, connected }) => this.onConnectionChange(userId, connected),
    );
    if (!this.enabled()) return;
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), CALL_SWEEP_EVERY_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.connectionSub?.unsubscribe();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const map of [
      this.ringTimers,
      this.pushTimers,
      this.disconnectTimers,
    ]) {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    }
  }

  enabled(): boolean {
    return staffCallsEnabled(this.config);
  }

  private assertEnabled(): void {
    if (!this.enabled())
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'CALLS_DISABLED',
        'Calls are not available',
      );
  }

  // ---------------------------------------------------------------- organisation

  /** The organisation (venue owner) a user belongs to, or null for players, guests, admins, inactive accounts. */
  async resolveOrg(
    userId: string,
  ): Promise<{ ownerId: string; kind: 'owner' | 'staff' } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { roles: true, status: true, isGuest: true },
    });
    if (!user || user.status !== 'active' || user.isGuest) return null;
    if (user.roles.includes('owner')) return { ownerId: userId, kind: 'owner' };
    if (user.roles.includes('staff')) {
      const row = await this.prisma.staffMember.findUnique({
        where: { userId },
        select: { ownerId: true },
      });
      return row ? { ownerId: row.ownerId, kind: 'staff' } : null;
    }
    return null;
  }

  /** Is `userId` the owner of this organisation or one of its staff, and is the account active? */
  private async inOrg(ownerId: string, userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, isGuest: true, roles: true },
    });
    if (!user || user.status !== 'active' || user.isGuest) return false;
    if (userId === ownerId) return user.roles.includes('owner');
    const row = await this.prisma.staffMember.findUnique({
      where: { userId },
      select: { ownerId: true },
    });
    return row?.ownerId === ownerId;
  }

  private async peerInfo(
    ownerId: string,
    ids: string[],
  ): Promise<Map<string, CallPeer>> {
    const unique = [...new Set(ids)];
    const [users, staff] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: unique } },
        select: { id: true, name: true, avatarUrl: true },
      }),
      this.prisma.staffMember.findMany({
        where: { ownerId, userId: { in: unique } },
        select: { userId: true, title: true },
      }),
    ]);
    const titles = new Map(staff.map((s) => [s.userId, s.title]));
    return new Map(
      users.map((u) => [
        u.id,
        {
          id: u.id,
          name: u.name,
          avatarUrl: u.avatarUrl ?? null,
          role: u.id === ownerId ? ('owner' as const) : ('staff' as const),
          title: titles.get(u.id) ?? null,
        },
      ]),
    );
  }

  // ---------------------------------------------------------------- directory

  async directory(userId: string): Promise<CallDirectory> {
    const off: CallDirectory = {
      enabled: false,
      members: [],
      dndUntil: null,
      missedUnseen: 0,
    };
    if (!this.enabled()) return off;
    const org = await this.resolveOrg(userId);
    if (!org) return off;
    const [owner, staff] = await Promise.all([
      this.prisma.user.findFirst({
        where: { id: org.ownerId, status: 'active', roles: { has: 'owner' } },
        select: { id: true },
      }),
      this.prisma.staffMember.findMany({
        where: { ownerId: org.ownerId },
        select: { userId: true },
      }),
    ]);
    const ids = [
      ...(owner ? [owner.id] : []),
      ...staff.map((s) => s.userId),
    ].filter((id) => id !== userId);
    const now = new Date();
    const [people, info, busy, mutes, settings, missedUnseen] =
      await Promise.all([
        this.prisma.user.findMany({
          where: { id: { in: ids }, status: 'active', isGuest: false },
          select: { id: true, lastSeenAt: true },
        }),
        this.peerInfo(org.ownerId, ids),
        this.busyUserIds(ids),
        this.prisma.callMute.findMany({
          where: { muterId: userId, until: { gt: now } },
        }),
        this.prisma.callSettings.findUnique({ where: { userId } }),
        this.prisma.staffCall.count({
          where: {
            calleeId: userId,
            status: { in: ['missed', 'cancelled'] },
            seenAt: null,
          },
        }),
      ]);
    const muted = new Map(mutes.map((m) => [m.mutedId, m.until]));
    const members: DirectoryMember[] = people
      .map((p) => ({
        ...info.get(p.id)!,
        online: this.presence.isOnline(p.id, p.lastSeenAt),
        busy: busy.has(p.id),
        mutedUntil: muted.get(p.id)?.toISOString() ?? null,
      }))
      .filter((m) => m.name)
      .sort(
        (a, b) =>
          Number(b.role === 'owner') - Number(a.role === 'owner') ||
          a.name.localeCompare(b.name, 'ar'),
      );
    return {
      enabled: true,
      members,
      dndUntil:
        settings?.dndUntil && settings.dndUntil > now
          ? settings.dndUntil.toISOString()
          : null,
      missedUnseen,
    };
  }

  // ---------------------------------------------------------------- availability

  private async busyUserIds(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.staffCall.findMany({
      where: {
        AND: [
          this.activeWhere(),
          { OR: [{ callerId: { in: ids } }, { calleeId: { in: ids } }] },
        ],
      },
      select: { callerId: true, calleeId: true },
    });
    const busy = new Set<string>();
    for (const r of rows) {
      busy.add(r.callerId);
      busy.add(r.calleeId);
    }
    return busy;
  }

  /** Rows that really are ringing or in progress (anything older is a leftover the sweeper will close). */
  private activeWhere(now = Date.now()) {
    return {
      OR: [
        {
          status: 'ringing' as const,
          createdAt: { gt: new Date(now - CALL_RING_MS - 10_000) },
        },
        {
          status: 'answered' as const,
          endedAt: null,
          answeredAt: { gt: new Date(now - CALL_MAX_DURATION_MS) },
        },
      ],
    };
  }

  private activeCallOf(userId: string) {
    return this.prisma.staffCall.findFirst({
      where: {
        AND: [
          this.activeWhere(),
          { OR: [{ callerId: userId }, { calleeId: userId }] },
        ],
      },
    });
  }

  private async unavailableFor(
    calleeId: string,
    callerId: string,
  ): Promise<boolean> {
    const now = new Date();
    const [settings, mute] = await Promise.all([
      this.prisma.callSettings.findUnique({ where: { userId: calleeId } }),
      this.prisma.callMute.findUnique({
        where: { muterId_mutedId: { muterId: calleeId, mutedId: callerId } },
      }),
    ]);
    return (
      (!!settings?.dndUntil && settings.dndUntil > now) ||
      (!!mute && mute.until > now)
    );
  }

  // ---------------------------------------------------------------- state machine

  create(callerId: string, calleeId: string) {
    const run = this.createChain.then(() => this.createNow(callerId, calleeId));
    this.createChain = run.catch(() => undefined);
    return run;
  }

  private async createNow(callerId: string, calleeId: string) {
    this.assertEnabled();
    if (callerId === calleeId)
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CALL_SELF',
        'You cannot call yourself',
      );
    const org = await this.resolveOrg(callerId);
    if (!org)
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'CALLS_NOT_AVAILABLE',
        'Calls are not available for this account',
      );
    if (!(await this.inOrg(org.ownerId, calleeId))) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'CALL_PEER_NOT_FOUND',
        'This person is not on your team',
      );
    }
    if (await this.activeCallOf(callerId)) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'ALREADY_IN_CALL',
        'Finish your current call first',
      );
    }
    const peers = await this.peerInfo(org.ownerId, [callerId, calleeId]);
    const callee = peers.get(calleeId)!;

    // Muted / do-not-disturb: log it for the caller only; the callee is never bothered and never told.
    if (await this.unavailableFor(calleeId, callerId)) {
      const row = await this.record(
        org.ownerId,
        callerId,
        calleeId,
        'unavailable',
      );
      return { call: this.view(row, callerId, callee), iceServers: null };
    }
    if (await this.activeCallOf(calleeId)) {
      const row = await this.record(org.ownerId, callerId, calleeId, 'busy');
      return { call: this.view(row, callerId, callee), iceServers: null };
    }

    const row = await this.prisma.staffCall.create({
      data: { ownerId: org.ownerId, callerId, calleeId, status: 'ringing' },
    });
    const live: LiveCall = {
      id: row.id,
      ownerId: org.ownerId,
      callerId,
      calleeId,
      status: 'ringing',
      pushed: false,
      ackNative: false,
      ackWeb: false,
      ringingEmitted: false,
    };
    this.live.set(row.id, live);
    this.setTimer(
      this.ringTimers,
      row.id,
      CALL_RING_MS,
      () => void this.expire(row.id),
    );

    const expiresAt = new Date(
      row.createdAt.getTime() + CALL_RING_MS,
    ).toISOString();
    this.emitter.emitToUser(calleeId, {
      type: 'call.incoming',
      callId: row.id,
      from: peers.get(callerId),
      createdAt: row.createdAt.toISOString(),
      expiresAt,
    });
    // Offline phones ring from a push at once; online ones get a short window to confirm first.
    const online = this.presence.isReachable(calleeId, 15_000);
    this.setTimer(
      this.pushTimers,
      row.id,
      online ? CALL_PUSH_DELAY_MS : 0,
      () => void this.pushRing(row.id),
    );
    return {
      call: this.view(row, callerId, callee),
      iceServers: this.squad.iceServers(callerId),
    };
  }

  private record(
    ownerId: string,
    callerId: string,
    calleeId: string,
    status: StaffCallStatus,
  ) {
    return this.prisma.staffCall.create({
      data: {
        ownerId,
        callerId,
        calleeId,
        status,
        endedAt: new Date(),
        endReason: status,
      },
    });
  }

  /** The callee's device says it is ringing. Native confirmation = no push needed at all. */
  async markRinging(
    userId: string,
    callId: string,
    native: boolean,
  ): Promise<void> {
    if (!this.enabled()) return;
    const live = await this.liveCall(callId);
    if (!live || live.calleeId !== userId || live.status !== 'ringing') return;
    if (native) {
      live.ackNative = true;
      this.clear(this.pushTimers, callId);
    } else {
      live.ackWeb = true;
    }
    if (!live.ringingEmitted) {
      live.ringingEmitted = true;
      this.emitter.emitToUser(live.callerId, { type: 'call.ringing', callId });
    }
  }

  private async pushRing(callId: string): Promise<void> {
    this.pushTimers.delete(callId);
    const live = this.live.get(callId);
    if (!live || live.status !== 'ringing' || live.ackNative) return;
    live.pushed = true;
    try {
      const [callee, caller] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: live.calleeId },
          select: { preferredLang: true },
        }),
        this.prisma.user.findUnique({
          where: { id: live.callerId },
          select: { name: true },
        }),
      ]);
      const ar = callee?.preferredLang !== 'en';
      const name = caller?.name ?? '';
      const message = {
        callId,
        kind: 'ring' as const,
        title: ar ? `مكالمة من ${name}` : `Call from ${name}`,
        body: ar ? 'اضغط للرد' : 'Tap to answer',
        deepLink: `/${ar ? 'ar' : 'en'}/owner`,
      };
      // The phone always rings. A browser tab that is open (it confirmed) must not also get a system toast.
      await Promise.all([
        this.fcm.sendCall(live.calleeId, message),
        live.ackWeb
          ? Promise.resolve()
          : this.webPush.sendCall(live.calleeId, {
              ...message,
              url: message.deepLink,
            }),
      ]);
    } catch (err) {
      this.logger.warn(`call push failed: ${String(err)}`);
    }
  }

  async accept(userId: string, callId: string) {
    this.assertEnabled();
    const row = await this.ownedRow(callId, userId, 'callee');
    if (row.status !== 'ringing') this.throwEnded(row);
    if (
      !(await this.inOrg(row.ownerId, userId)) ||
      !(await this.inOrg(row.ownerId, row.callerId))
    ) {
      await this.finish(row.id, 'ringing', 'failed', 'membership');
      throw new ApiException(
        HttpStatus.GONE,
        'CALL_ENDED',
        'This call is no longer available',
        { status: 'failed' },
      );
    }
    const updated = await this.prisma.staffCall.updateMany({
      where: { id: callId, status: 'ringing' },
      data: { status: 'answered', answeredAt: new Date() },
    });
    if (!updated.count)
      this.throwEnded(
        await this.prisma.staffCall.findUniqueOrThrow({
          where: { id: callId },
        }),
      );
    this.clear(this.ringTimers, callId);
    this.clear(this.pushTimers, callId);
    const live = this.live.get(callId);
    if (live) live.status = 'answered';
    else
      this.live.set(callId, {
        id: callId,
        ownerId: row.ownerId,
        callerId: row.callerId,
        calleeId: row.calleeId,
        status: 'answered',
        pushed: false,
        ackNative: false,
        ackWeb: false,
        ringingEmitted: true,
      });
    const event = { type: 'call.accepted', callId, byUserId: userId };
    this.emitter.emitToUser(row.callerId, event);
    this.emitter.emitToUser(row.calleeId, event);
    const peers = await this.peerInfo(row.ownerId, [row.callerId]);
    const fresh = await this.prisma.staffCall.findUniqueOrThrow({
      where: { id: callId },
    });
    return {
      call: this.view(fresh, userId, peers.get(row.callerId)!),
      iceServers: this.squad.iceServers(userId),
    };
  }

  async decline(userId: string, callId: string) {
    this.assertEnabled();
    const row = await this.ownedRow(callId, userId, 'callee');
    if (row.status === 'ringing')
      await this.finish(callId, 'ringing', 'declined', 'declined', true);
    return { ok: true };
  }

  async cancel(userId: string, callId: string) {
    this.assertEnabled();
    const row = await this.ownedRow(callId, userId, 'caller');
    if (row.status === 'ringing')
      await this.finish(callId, 'ringing', 'cancelled', 'cancelled', true);
    return { ok: true };
  }

  /** Hang up. Either party; a ringing call is cancelled (caller) or declined (callee). Idempotent. */
  async end(userId: string, callId: string) {
    this.assertEnabled();
    const row = await this.ownedRow(callId, userId, 'either');
    if (row.status === 'ringing') {
      if (row.callerId === userId)
        await this.finish(callId, 'ringing', 'cancelled', 'cancelled', true);
      else await this.finish(callId, 'ringing', 'declined', 'declined', true);
    } else if (row.status === 'answered') {
      await this.finish(callId, 'answered', 'ended', 'hangup', true);
    }
    return { ok: true };
  }

  private async expire(callId: string): Promise<void> {
    this.ringTimers.delete(callId);
    await this.finish(callId, 'ringing', 'missed', 'timeout', true);
  }

  /**
   * Moves a call out of `from` into a final state exactly once (an atomic conditional update, so a
   * timer, a hang-up and a disconnect racing each other cannot double-finish), then tells both sides.
   */
  private async finish(
    callId: string,
    from: 'ringing' | 'answered',
    to: StaffCallStatus,
    reason: string,
    notify = true,
  ): Promise<boolean> {
    const done = await this.prisma.staffCall.updateMany({
      where: { id: callId, status: from },
      data: { status: to, endedAt: new Date(), endReason: reason },
    });
    if (!done.count) return false;
    this.clear(this.ringTimers, callId);
    this.clear(this.pushTimers, callId);
    const live = this.live.get(callId);
    this.live.delete(callId);
    const row = await this.prisma.staffCall.findUnique({
      where: { id: callId },
    });
    if (!row) return true;
    if (notify) {
      const event = { type: 'call.ended', callId, status: to, reason };
      this.emitter.emitToUser(row.callerId, event);
      this.emitter.emitToUser(row.calleeId, event);
    }
    // Rung but never answered: the callee gets a "missed call" (it also replaces the ringing push).
    if (from === 'ringing' && (to === 'missed' || to === 'cancelled')) {
      await this.missedNotice(row, live?.pushed ?? false).catch((err) =>
        this.logger.warn(`missed-call notice failed: ${String(err)}`),
      );
    }
    return true;
  }

  private async missedNotice(row: StaffCall, pushed: boolean): Promise<void> {
    const [callee, caller] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: row.calleeId },
        select: { preferredLang: true },
      }),
      this.prisma.user.findUnique({
        where: { id: row.callerId },
        select: { name: true },
      }),
    ]);
    const name = caller?.name ?? '';
    const ar = callee?.preferredLang !== 'en';
    const deepLink = `/${ar ? 'ar' : 'en'}/owner`;
    await this.notifications.create({
      dedupKey: `call-missed:${row.id}`,
      userId: row.calleeId,
      category: 'calls',
      titleAr: `مكالمة فائتة من ${name}`,
      titleEn: `Missed call from ${name}`,
      bodyAr: 'افتح قائمة الفريق للاتصال به',
      bodyEn: 'Open the team list to call back',
      deepLink,
      payload: { kind: 'missed_call', callId: row.id, callerId: row.callerId },
      noPush: true,
    });
    // Only phones/tabs that were pushed (or are offline) need the replacement; an open app shows the bell.
    if (pushed || !this.presence.isReachable(row.calleeId, 15_000)) {
      const message = {
        callId: row.id,
        kind: 'missed' as const,
        title: ar ? `مكالمة فائتة من ${name}` : `Missed call from ${name}`,
        body: ar
          ? 'افتح قائمة الفريق للاتصال به'
          : 'Open the team list to call back',
        deepLink,
      };
      await Promise.all([
        this.fcm.sendCall(row.calleeId, message),
        this.webPush.sendCall(row.calleeId, { ...message, url: deepLink }),
      ]);
    }
  }

  private async ownedRow(
    callId: string,
    userId: string,
    as: 'caller' | 'callee' | 'either',
  ): Promise<StaffCall> {
    const row = await this.prisma.staffCall.findUnique({
      where: { id: callId },
    });
    const allowed =
      !!row &&
      (as === 'caller'
        ? row.callerId === userId
        : as === 'callee'
          ? row.calleeId === userId
          : row.callerId === userId || row.calleeId === userId);
    if (!row || !allowed)
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'CALL_NOT_FOUND',
        'Call not found',
      );
    return row;
  }

  private throwEnded(row: StaffCall): never {
    if (row.status === 'answered') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'CALL_ALREADY_ANSWERED',
        'This call was already answered',
        { status: row.status },
      );
    }
    throw new ApiException(
      HttpStatus.GONE,
      'CALL_ENDED',
      'This call has ended',
      { status: row.status },
    );
  }

  // ---------------------------------------------------------------- signaling relay

  /** The other party of an ANSWERED call that `userId` belongs to; null for anything else. */
  async relayPeer(userId: string, callId: string): Promise<string | null> {
    if (!this.enabled()) return null;
    const live = await this.liveCall(callId);
    if (!live || live.status !== 'answered') return null;
    if (live.callerId === userId) return live.calleeId;
    if (live.calleeId === userId) return live.callerId;
    return null;
  }

  private async liveCall(callId: string): Promise<LiveCall | null> {
    const cached = this.live.get(callId);
    if (cached) return cached;
    const row = await this.prisma.staffCall.findFirst({
      where: { AND: [{ id: callId }, this.activeWhere()] },
    });
    if (!row || (row.status !== 'ringing' && row.status !== 'answered'))
      return null;
    const live: LiveCall = {
      id: row.id,
      ownerId: row.ownerId,
      callerId: row.callerId,
      calleeId: row.calleeId,
      status: row.status,
      pushed: false,
      ackNative: false,
      ackWeb: false,
      ringingEmitted: true,
    };
    this.live.set(row.id, live);
    return live;
  }

  // ---------------------------------------------------------------- reads

  /** What is ringing for me / in progress right now (the app asks after boot, reconnect or a push tap). */
  async active(userId: string) {
    if (!this.enabled()) return { incoming: null, current: null };
    const rows = await this.prisma.staffCall.findMany({
      where: {
        AND: [
          this.activeWhere(),
          { OR: [{ callerId: userId }, { calleeId: userId }] },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
    const ownerId = rows[0]?.ownerId;
    if (!ownerId) return { incoming: null, current: null };
    const info = await this.peerInfo(
      ownerId,
      rows.flatMap((r) => [r.callerId, r.calleeId]),
    );
    const mine = (r: StaffCall) =>
      info.get(r.callerId === userId ? r.calleeId : r.callerId)!;
    const incoming = rows.find(
      (r) => r.status === 'ringing' && r.calleeId === userId,
    );
    const current = rows.find(
      (r) =>
        r.status === 'answered' ||
        (r.status === 'ringing' && r.callerId === userId),
    );
    return {
      incoming: incoming ? this.view(incoming, userId, mine(incoming)) : null,
      current: current ? this.view(current, userId, mine(current)) : null,
    };
  }

  async recent(userId: string, limit = 30) {
    if (!this.enabled()) return { items: [] as CallView[], missedUnseen: 0 };
    const take = Math.min(Math.max(Math.floor(limit) || 30, 1), 50);
    const rows = await this.prisma.staffCall.findMany({
      where: {
        OR: [
          { callerId: userId },
          { calleeId: userId, status: { notIn: ['unavailable', 'busy'] } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    const ownerId = rows[0]?.ownerId;
    const info = ownerId
      ? await this.peerInfo(
          ownerId,
          rows.map((r) => (r.callerId === userId ? r.calleeId : r.callerId)),
        )
      : new Map<string, CallPeer>();
    const items = rows
      .map((r) => {
        const peer = info.get(r.callerId === userId ? r.calleeId : r.callerId);
        return peer ? this.view(r, userId, peer) : null;
      })
      .filter((v): v is CallView => !!v);
    return { items, missedUnseen: items.filter((i) => i.unseen).length };
  }

  async markSeen(userId: string) {
    if (!this.enabled()) return { ok: true };
    await this.prisma.staffCall.updateMany({
      where: {
        calleeId: userId,
        status: { in: ['missed', 'cancelled'] },
        seenAt: null,
      },
      data: { seenAt: new Date() },
    });
    return { ok: true };
  }

  iceServers(userId: string) {
    this.assertEnabled();
    return this.squad.iceServers(userId);
  }

  private view(row: StaffCall, userId: string, peer: CallPeer): CallView {
    const incoming = row.calleeId === userId;
    return {
      id: row.id,
      status: row.status,
      direction: incoming ? 'in' : 'out',
      peer,
      createdAt: row.createdAt.toISOString(),
      answeredAt: row.answeredAt?.toISOString() ?? null,
      endedAt: row.endedAt?.toISOString() ?? null,
      expiresAt:
        row.status === 'ringing'
          ? new Date(row.createdAt.getTime() + CALL_RING_MS).toISOString()
          : null,
      unseen:
        incoming &&
        (row.status === 'missed' || row.status === 'cancelled') &&
        !row.seenAt,
    };
  }

  // ---------------------------------------------------------------- mute / do-not-disturb

  async setMute(userId: string, targetId: string, minutes: number) {
    this.assertEnabled();
    const org = await this.resolveOrg(userId);
    if (
      !org ||
      targetId === userId ||
      !(await this.inOrg(org.ownerId, targetId))
    ) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'CALL_PEER_NOT_FOUND',
        'This person is not on your team',
      );
    }
    const until = new Date(Date.now() + this.clampMinutes(minutes, 1) * 60_000);
    await this.prisma.callMute.upsert({
      where: { muterId_mutedId: { muterId: userId, mutedId: targetId } },
      update: { until, ownerId: org.ownerId },
      create: {
        ownerId: org.ownerId,
        muterId: userId,
        mutedId: targetId,
        until,
      },
    });
    return { mutedUntil: until.toISOString() };
  }

  async clearMute(userId: string, targetId: string) {
    this.assertEnabled();
    await this.prisma.callMute.deleteMany({
      where: { muterId: userId, mutedId: targetId },
    });
    return { mutedUntil: null };
  }

  async setDnd(userId: string, minutes: number) {
    this.assertEnabled();
    if (!(await this.resolveOrg(userId))) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'CALLS_NOT_AVAILABLE',
        'Calls are not available for this account',
      );
    }
    const dndUntil =
      minutes > 0
        ? new Date(Date.now() + this.clampMinutes(minutes, 1) * 60_000)
        : null;
    await this.prisma.callSettings.upsert({
      where: { userId },
      update: { dndUntil },
      create: { userId, dndUntil },
    });
    return { dndUntil: dndUntil?.toISOString() ?? null };
  }

  private clampMinutes(minutes: number, min: number): number {
    return Math.min(
      Math.max(Math.floor(minutes) || min, min),
      MAX_MUTE_MINUTES,
    );
  }

  // ---------------------------------------------------------------- housekeeping

  /** A party's last socket went away: forgive a flap, end the call if they do not come back. */
  private onConnectionChange(userId: string, connected: boolean): void {
    if (connected) {
      this.clear(this.disconnectTimers, userId);
      return;
    }
    if (!this.enabled()) return;
    const mine = [...this.live.values()].filter(
      (c) =>
        (c.status === 'answered' &&
          (c.callerId === userId || c.calleeId === userId)) ||
        (c.status === 'ringing' && c.callerId === userId),
    );
    if (!mine.length) return;
    this.setTimer(
      this.disconnectTimers,
      userId,
      CALL_DISCONNECT_GRACE_MS,
      () => {
        this.disconnectTimers.delete(userId);
        if (this.presence.isReachable(userId, 10_000)) return;
        for (const call of mine) {
          if (call.status === 'answered')
            void this.finish(call.id, 'answered', 'ended', 'disconnected');
          else void this.finish(call.id, 'ringing', 'cancelled', 'caller_gone');
        }
      },
    );
  }

  /** Closes rows no timer will ever close (a restart, a lost timer) and trims the old log. */
  async sweep(now = Date.now()): Promise<void> {
    try {
      await this.prisma.staffCall.updateMany({
        where: {
          status: 'ringing',
          createdAt: { lt: new Date(now - CALL_RING_MS - 10_000) },
        },
        data: { status: 'missed', endedAt: new Date(now), endReason: 'swept' },
      });
      await this.prisma.staffCall.updateMany({
        where: {
          status: 'answered',
          endedAt: null,
          answeredAt: { lt: new Date(now - CALL_MAX_DURATION_MS) },
        },
        data: { status: 'ended', endedAt: new Date(now), endReason: 'swept' },
      });
      if (now - this.lastRetentionRun > 6 * 60 * 60 * 1000) {
        this.lastRetentionRun = now;
        const cutoff = new Date(
          now - CALL_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        );
        await this.prisma.staffCall.deleteMany({
          where: {
            createdAt: { lt: cutoff },
            status: { notIn: ACTIVE_STATUSES },
          },
        });
        await this.prisma.callMute.deleteMany({
          where: { until: { lt: new Date(now) } },
        });
      }
    } catch (err) {
      this.logger.warn(`call sweep failed: ${String(err)}`);
    }
  }

  private setTimer(
    map: Map<string, NodeJS.Timeout>,
    key: string,
    ms: number,
    fn: () => void,
  ): void {
    this.clear(map, key);
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    map.set(key, timer);
  }

  private clear(map: Map<string, NodeJS.Timeout>, key: string): void {
    const timer = map.get(key);
    if (timer) clearTimeout(timer);
    map.delete(key);
  }
}
