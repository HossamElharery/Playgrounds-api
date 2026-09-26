import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  PROPOSAL_DAY_SPAN,
  PROPOSAL_TTL_MS,
  addCalendarDays,
  cairoLocalToUtcMs,
  cairoYmd,
} from './lobby-kiosk.clock';
import {
  judgeProposal,
  type KioskPresence,
  type KioskShortlistItem,
  type KioskSquadState,
  type KioskVote,
  type NextMatch,
  type Proposal,
  type ProposeInput,
} from './lobby-kiosk.types';

/** At most this many kiosk messages per user per second. */
export const KIOSK_RATE = 5;

export interface KioskBroadcaster {
  emit(squadId: string, event: string, payload: object): void;
}

/** Presence updates are tighter than the general kiosk budget. */
export const KIOSK_PRESENCE_RATE = 4;

interface SquadRuntime {
  proposal: Proposal | null;
  busy: Set<string>;
  nextMatch: NextMatch | null;
  shortlist: KioskShortlistItem[];
  presence: KioskPresence[];
}

interface MemberRow {
  userId: string;
  isLeader: boolean;
}

const MAX_ID = 64;

/**
 * In-memory squad booking proposals. The gateway authenticates and checks the
 * room; this service validates the venue, the slot and the vote, then broadcasts.
 */
@Injectable()
export class LobbyKioskService implements OnModuleDestroy {
  broadcaster: KioskBroadcaster | null = null;

  private readonly squads = new Map<string, SquadRuntime>();
  private readonly hits = new Map<string, number[]>();
  private readonly presenceHits = new Map<string, number[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.broadcaster = null;
  }

  /** Token window: 5 messages / second / user. */
  allow(userId: string, now = Date.now()): boolean {
    const start = now - 1000;
    const prev = this.hits.get(userId);
    const kept: number[] = [];
    if (prev) {
      for (let i = 0; i < prev.length; i++) if (prev[i] > start) kept.push(prev[i]);
    }
    if (kept.length >= KIOSK_RATE) {
      this.hits.set(userId, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(userId, kept);
    return true;
  }

  state(squadId: string, now = Date.now()): KioskSquadState {
    this.sweepNext(now);
    const s = this.squads.get(squadId);
    if (!s) return { proposal: null, busy: [], nextMatch: null, shortlist: [], presence: [] };
    return {
      proposal: s.proposal,
      busy: [...s.busy],
      nextMatch: s.nextMatch,
      shortlist: s.shortlist.map((item) => ({ ...item })),
      presence: s.presence.map((item) => ({ ...item, center: item.center ? { ...item.center } : undefined })),
    };
  }

  setBusy(squadId: string, userId: string, busy: boolean): void {
    const s = this.runtime(squadId);
    if (busy) s.busy.add(userId);
    else s.busy.delete(userId);
    this.emit(squadId, 'lobby.kiosk.busy', { userId, busy });
    if (!busy) this.maybeDrop(squadId);
  }

  async propose(
    userId: string,
    input: ProposeInput,
    now = Date.now(),
  ): Promise<Proposal | null> {
    if (!validId(input.squadId) || !validId(input.venueId)) return null;
    const date = input.date;
    const startTime = input.startTime;
    const startsAt = cairoLocalToUtcMs(date, startTime);
    if (startsAt === null || startsAt < now) return null;
    const today = cairoYmd(new Date(now));
    if (date < today || date > addCalendarDays(today, PROPOSAL_DAY_SPAN)) return null;
    const durationMin = input.durationMin;
    if (!Number.isInteger(durationMin) || durationMin < 15 || durationMin > 180) return null;
    if (input.priceFrom !== undefined && !(Number.isFinite(input.priceFrom) && input.priceFrom >= 0))
      return null;
    const playersNeeded =
      Number.isInteger(input.playersNeeded) && (input.playersNeeded as number) >= 2 && (input.playersNeeded as number) <= 30
        ? input.playersNeeded
        : undefined;

    const s = this.runtime(input.squadId);
    if (s.proposal?.status === 'open') return null;

    const venue = await this.prisma.venue
      .findUnique({
        where: { id: input.venueId },
        select: {
          id: true,
          slug: true,
          status: true,
          nameAr: true,
          nameEn: true,
          photos: { take: 1, orderBy: { position: 'asc' }, select: { url: true } },
        },
      })
      .catch(() => null);
    if (!venue || venue.status !== 'active') return null;

    let courtId: string | null = null;
    if (typeof input.courtId === 'string' && input.courtId) {
      if (!validId(input.courtId)) return null;
      const court = await this.prisma.court
        .findFirst({
          where: { id: input.courtId, venueId: venue.id },
          select: { id: true },
        })
        .catch(() => null);
      if (!court) return null;
      courtId = court.id;
    }

    const proposal: Proposal = {
      id: crypto.randomUUID(),
      squadId: input.squadId,
      proposerId: userId,
      venueId: venue.id,
      venueSlug: venue.slug,
      venueName: venue.nameAr,
      venueNameEn: venue.nameEn,
      venuePhoto: venue.photos[0]?.url,
      courtId,
      date,
      startTime,
      durationMin,
      priceFrom: input.priceFrom,
      playersNeeded,
      votes: { [userId]: 'yes' },
      createdAt: now,
      expiresAt: now + PROPOSAL_TTL_MS,
      status: 'open',
    };
    s.proposal = proposal;
    this.emit(input.squadId, 'lobby.kiosk.proposal', { proposal });
    await this.evaluate(s, now);
    this.ensureTimer();
    return s.proposal;
  }

  async vote(
    userId: string,
    squadId: string,
    proposalId: string,
    vote: unknown,
    now = Date.now(),
  ): Promise<boolean> {
    if (vote !== 'yes' && vote !== 'no') return false;
    const s = this.squads.get(squadId);
    const p = s?.proposal;
    if (!s || !p || p.status !== 'open' || p.id !== proposalId) return false;
    p.votes[userId] = vote;
    this.emit(squadId, 'lobby.kiosk.vote', {
      proposalId: p.id,
      userId,
      vote,
      votes: p.votes,
    });
    await this.evaluate(s, now);
    return true;
  }

  async cancel(userId: string, squadId: string, proposalId: string): Promise<boolean> {
    const s = this.squads.get(squadId);
    const p = s?.proposal;
    if (!s || !p || p.status !== 'open' || p.id !== proposalId) return false;
    const members = await this.members(squadId);
    const leader = members.find((m) => m.isLeader)?.userId;
    if (userId !== p.proposerId && userId !== leader) return false;
    this.resolve(s, 'cancelled');
    return true;
  }

  /**
   * A booking made from a passed (or still-open) proposal. The row must exist,
   * belong to this user, match the proposal venue, and start in the future.
   */
  async booked(
    userId: string,
    squadId: string,
    proposalId: string,
    bookingId: string,
    now = Date.now(),
  ): Promise<boolean> {
    if (!validId(bookingId)) return false;
    const s = this.squads.get(squadId);
    const p = s?.proposal;
    if (!s || !p || p.id !== proposalId || p.status === 'cancelled') return false;
    const booking = await this.prisma.booking
      .findUnique({
        where: { id: bookingId },
        select: { id: true, userId: true, venueId: true, slotStart: true, status: true },
      })
      .catch(() => null);
    if (!booking || booking.userId !== userId) return false;
    if (booking.venueId !== p.venueId) return false;
    if (booking.status === 'cancelled') return false;
    if (booking.slotStart.getTime() <= now) return false;
    s.nextMatch = {
      venueName: p.venueName,
      venueSlug: p.venueSlug,
      startsAt: booking.slotStart.toISOString(),
      bookingId: booking.id,
      bookerId: userId,
    };
    this.emit(squadId, 'lobby.kiosk.nextMatch', { nextMatch: s.nextMatch });
    return true;
  }

  squadEmptied(squadId: string): void {
    this.squads.delete(squadId);
    this.maybeStopTimer();
  }

  memberLeft(squadId: string, userId: string): void {
    const s = this.squads.get(squadId);
    if (!s) return;
    if (s.busy.delete(userId)) this.emit(squadId, 'lobby.kiosk.busy', { userId, busy: false });
    if (s.presence.some((item) => item.userId === userId)) {
      s.presence = s.presence.filter((item) => item.userId !== userId);
      this.emit(squadId, 'lobby.kiosk.presence', { userId, closed: true });
    }
    this.maybeDrop(squadId);
  }

  /**
   * Panel presence. `center` is the map camera while the member pans.
   * The device GPS is never accepted and never broadcast.
   */
  setPresence(
    squadId: string,
    userId: string,
    input: { venueId?: string; center?: { lat: number; lng: number; zoom: number } } | null,
    now = Date.now(),
  ): boolean {
    if (!this.allowPresence(userId, now)) return false;
    const s = this.runtime(squadId);
    s.presence = s.presence.filter((item) => item.userId !== userId);
    if (input) {
      const next: KioskPresence = { userId };
      if (input.venueId && validId(input.venueId)) next.venueId = input.venueId;
      const c = input.center;
      if (c && [c.lat, c.lng, c.zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) {
        next.center = { lat: c.lat, lng: c.lng, zoom: c.zoom };
      }
      s.presence.push(next);
      this.emit(squadId, 'lobby.kiosk.presence', next);
    } else {
      this.emit(squadId, 'lobby.kiosk.presence', { userId, closed: true });
      this.maybeDrop(squadId);
    }
    return true;
  }

  async addShortlist(squadId: string, userId: string, venueId: string): Promise<boolean> {
    if (!validId(venueId)) return false;
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, status: true } }).catch(() => null);
    if (!venue || venue.status !== 'active') return false;
    const s = this.runtime(squadId);
    if (s.shortlist.some((item) => item.venueId === venueId)) return true;
    if (s.shortlist.length >= 5) return false;
    s.shortlist.push({ venueId, userId });
    this.emit(squadId, 'lobby.kiosk.shortlist', { shortlist: s.shortlist });
    return true;
  }

  async removeShortlist(squadId: string, userId: string, venueId: string): Promise<boolean> {
    const s = this.squads.get(squadId);
    if (!s) return false;
    const item = s.shortlist.find((row) => row.venueId === venueId);
    if (!item) return false;
    const members = await this.members(squadId);
    const leader = members.some((m) => m.userId === userId && m.isLeader);
    if (item.userId !== userId && !leader) return false;
    s.shortlist = s.shortlist.filter((row) => row.venueId !== venueId);
    this.emit(squadId, 'lobby.kiosk.shortlist', { shortlist: s.shortlist });
    this.maybeDrop(squadId);
    return true;
  }

  private allowPresence(userId: string, now: number): boolean {
    const start = now - 1000;
    const prev = this.presenceHits.get(userId) ?? [];
    const kept = prev.filter((t) => t > start);
    if (kept.length >= KIOSK_PRESENCE_RATE) {
      this.presenceHits.set(userId, kept);
      return false;
    }
    kept.push(now);
    this.presenceHits.set(userId, kept);
    return true;
  }

  /** One-second sweep: expire open proposals and stale next-match chips. */
  tick(now = Date.now()): void {
    for (const s of this.squads.values()) {
      const p = s.proposal;
      if (p && p.status === 'open' && now >= p.expiresAt) this.resolve(s, 'failed');
    }
    this.sweepNext(now);
    this.pruneHits(now);
    this.maybeStopTimer();
  }

  private async evaluate(s: SquadRuntime, now: number): Promise<void> {
    const p = s.proposal;
    if (!p || p.status !== 'open') return;
    if (now >= p.expiresAt) {
      this.resolve(s, 'failed');
      return;
    }
    const members = await this.members(p.squadId);
    const ids = new Set(members.map((m) => m.userId));
    let yes = 0;
    let no = 0;
    for (const [id, vote] of Object.entries(p.votes)) {
      if (!ids.has(id)) continue;
      if (vote === 'yes') yes++;
      else no++;
    }
    const leaderYes = members.some((m) => m.isLeader && p.votes[m.userId] === 'yes');
    const result = judgeProposal(yes, no, members.length, leaderYes);
    if (result !== 'open') this.resolve(s, result);
  }

  private resolve(s: SquadRuntime, status: 'passed' | 'failed' | 'cancelled'): void {
    const p = s.proposal;
    if (!p || p.status !== 'open') return;
    p.status = status;
    this.emit(p.squadId, 'lobby.kiosk.resolved', { proposalId: p.id, status, proposal: p });
    this.maybeStopTimer();
  }

  private sweepNext(now: number): void {
    for (const [squadId, s] of this.squads) {
      if (!s.nextMatch) continue;
      if (Date.parse(s.nextMatch.startsAt) > now) continue;
      s.nextMatch = null;
      this.emit(squadId, 'lobby.kiosk.nextMatch', { nextMatch: null });
      this.maybeDrop(squadId);
    }
  }

  private async members(squadId: string): Promise<MemberRow[]> {
    const rows = await this.prisma.squadMember
      .findMany({ where: { squadId }, select: { userId: true, isLeader: true } })
      .catch(() => [] as MemberRow[]);
    return rows;
  }

  private runtime(squadId: string): SquadRuntime {
    let s = this.squads.get(squadId);
    if (!s) {
      s = { proposal: null, busy: new Set(), nextMatch: null, shortlist: [], presence: [] };
      this.squads.set(squadId, s);
    }
    return s;
  }

  private maybeDrop(squadId: string): void {
    const s = this.squads.get(squadId);
    if (!s || s.proposal || s.busy.size || s.nextMatch || s.shortlist.length || s.presence.length) return;
    this.squads.delete(squadId);
    this.maybeStopTimer();
  }

  private ensureTimer(): void {
    if (this.timer || !this.hasOpen()) return;
    this.timer = setInterval(() => this.tick(Date.now()), 1000);
    this.timer.unref?.();
  }

  private maybeStopTimer(): void {
    if (this.hasOpen()) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private hasOpen(): boolean {
    for (const s of this.squads.values()) if (s.proposal?.status === 'open') return true;
    return false;
  }

  private pruneHits(now: number): void {
    const start = now - 1000;
    for (const [id, arr] of this.hits) {
      if (arr.length === 0 || arr[arr.length - 1] <= start) this.hits.delete(id);
    }
  }

  private emit(squadId: string, event: string, payload: object): void {
    this.broadcaster?.emit(squadId, event, payload);
  }
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID;
}

export type { KioskVote };
