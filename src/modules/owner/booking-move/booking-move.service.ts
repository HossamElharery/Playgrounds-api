import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import {
  assertBookingAccess,
  assertStaffPermission,
} from '../../../common/access/owner-access';
import { ApiException } from '../../../common/errors/api-exception';
import { isPastSlotStart } from '../../../common/utils/past-slot.util';
import {
  coveringPricingRule,
  hasPricingCoverage,
} from '../../../common/utils/pricing-rule.util';
import { quoteDurationPrice } from '../../../common/utils/price-quote.util';
import { usesMinuteTiming } from '../../../common/utils/activity-timing.util';
import { lockVenueSlots } from '../../../common/utils/slot-lock.util';
import {
  zonedDayBounds,
  zonedWeekday,
  zonedYmd,
} from '../../../common/utils/timezone.util';
import { hasOpeningHours } from '../../../common/utils/venue-readiness.util';
import type { WeeklyHours } from '../../../common/utils/weekly-hours.util';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { LedgerService } from '../../finance/ledger.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { derivePaymentStatus, netReceived } from '../cash/payment-trail';
import { OwnerBookingsService } from '../owner-bookings.service';
import { MoveBookingDto, MoveBookingPreviewDto } from './booking-move.dto';
import {
  type BusySpan,
  type MoveBlocker,
  type MoveReason,
  type MoveSourceFacts,
  candidateStarts,
  isWholeMinute,
  moveBlocker,
  nearestFirst,
  onSlotGrid,
  overlapsBusy,
  priceVerdict,
  tooFarAhead,
  withinOpeningHours,
} from './booking-move.rules';

type Db = Prisma.TransactionClient | PrismaService;

const LIVE = ['held', 'confirmed'] as const;
const OPEN_INTENTS = [
  'created',
  'pending',
  'refund_pending',
  'needs_review',
] as const;
const MAX_UNITS = 60;
const PER_GROUP = 8;

/** HTTP status for each refusal. Anything about the booking or its money is 409; a malformed target is 400. */
const STATUS: Partial<Record<string, HttpStatus>> = {
  INVALID_SLOT_START: HttpStatus.BAD_REQUEST,
  INVALID_DURATION: HttpStatus.BAD_REQUEST,
  SLOT_IN_PAST: HttpStatus.BAD_REQUEST,
  BOOKING_TOO_FAR_AHEAD: HttpStatus.BAD_REQUEST,
  NOTHING_TO_MOVE: HttpStatus.BAD_REQUEST,
  UNIT_NOT_COMPATIBLE: HttpStatus.BAD_REQUEST,
  UNIT_NOT_BOOKABLE: HttpStatus.CONFLICT,
};

const MESSAGE: Record<string, string> = {
  NOTHING_TO_MOVE: 'The booking is already at this time and place',
  UNIT_NOT_COMPATIBLE: 'This booking cannot move to that court',
  UNIT_NOT_BOOKABLE: 'That court is not open for bookings',
  SLOT_IN_PAST: 'This time has already passed',
  BOOKING_TOO_FAR_AHEAD: 'Bookings can be made up to 90 days ahead',
  INVALID_SLOT_START: 'The time must match the court schedule',
  INVALID_DURATION: 'The booking length does not fit that court',
  VENUE_HOURS_REQUIRED: 'Set the venue opening hours first',
  OUTSIDE_HOURS: 'That time is outside the opening hours',
  PRICE_REQUIRED: 'That court has no price for this time',
  PRICE_LOWER_USE_REFUND:
    'The new time costs less than the player paid. Cancel the booking so the player is refunded, then book again',
  SLOT_ALREADY_HELD: 'That time is already taken',
  SLOT_BLOCKED: 'That time is blocked',
  USER_TIME_CONFLICT: 'The player already has another booking at that time',
  BOOKING_NOT_MOVABLE_STATUS: 'Only a confirmed booking can be moved',
  BOOKING_CHECKED_IN: 'The player already arrived',
  BOOKING_HAS_SESSION:
    'A session is running on this booking. Transfer the session instead',
  BOOKING_IN_SERIES:
    'This booking belongs to a fixed booking. Change the fixed booking instead',
  BOOKING_IN_BUNDLE: 'This booking is part of a package and cannot be moved',
  BOOKING_MEMBERSHIP: 'This booking uses membership hours and cannot be moved',
  BOOKING_PULSE:
    'This booking is part of a last-minute offer and cannot be moved',
  BOOKING_SPLIT_PENDING:
    'Some friends have not paid their share yet. Wait until the split is settled',
  BOOKING_PAYMENT_PENDING:
    'A card payment on this booking is still being processed',
  BOOKING_PAYMENT_STATE: 'This booking was refunded or its payment failed',
  BOOKING_STARTED:
    'The booking time has started. Use came / did not come instead',
  BOOKING_TOO_OLD: 'Bookings older than 90 days cannot be changed',
  PLATFORM_MOVE_DISABLED:
    'Moving Matchena bookings is not switched on yet. Send a change request instead',
  VENUE_OPERATIONS_PAUSED:
    'The owner operations system is paused for this venue',
};

const REASON_ORDER: MoveReason[] = [
  'UNIT_NOT_COMPATIBLE',
  'UNIT_NOT_BOOKABLE',
  'NOTHING_TO_MOVE',
  'INVALID_SLOT_START',
  'INVALID_DURATION',
  'SLOT_IN_PAST',
  'BOOKING_TOO_FAR_AHEAD',
  'VENUE_HOURS_REQUIRED',
  'OUTSIDE_HOURS',
  'PRICE_REQUIRED',
  'PRICE_LOWER_USE_REFUND',
  'SLOT_BLOCKED',
  'SLOT_ALREADY_HELD',
  'USER_TIME_CONFLICT',
];

function refuse(code: string): never {
  throw new ApiException(
    STATUS[code] ?? HttpStatus.CONFLICT,
    code,
    MESSAGE[code] ?? 'This booking cannot be moved',
  );
}

/** "YYYY-MM-DD" that exists on the calendar. Date.parse alone accepts 2026-02-31 by rolling it forward. */
function isRealDate(ymd: string): boolean {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === ymd;
}

const BOOKING_LOAD = {
  usageSession: { select: { id: true } },
  pulseOpportunity: { select: { id: true } },
  pulseClaims: {
    where: { state: { in: ['held', 'confirmed'] } },
    select: { id: true },
  },
  splitShares: { where: { status: 'pending' }, select: { id: true } },
  paymentIntents: {
    where: { status: { in: [...OPEN_INTENTS] } },
    select: { id: true },
  },
  court: {
    select: {
      id: true,
      name: true,
      sportId: true,
      sport: { select: { activityKind: true } },
    },
  },
  venue: {
    select: {
      id: true,
      ownerId: true,
      currency: true,
      weeklyHours: true,
      operationsEnabled: true,
      nameEn: true,
      nameAr: true,
      country: { select: { timezone: true } },
    },
  },
} satisfies Prisma.BookingInclude;

type LoadedBooking = Prisma.BookingGetPayload<{ include: typeof BOOKING_LOAD }>;

const COURT_LOAD = {
  sport: { select: { activityKind: true } },
  pricingRules: true,
} satisfies Prisma.CourtInclude;

type LoadedCourt = Prisma.CourtGetPayload<{ include: typeof COURT_LOAD }>;

interface Source {
  b: LoadedBooking;
  timeZone: string;
  kind: string | null;
  durationMinutes: number;
  received: number;
  facts: MoveSourceFacts;
}

export interface PriceView {
  currentTotal: number;
  modes: Array<'keep' | 'reprice'>;
  requiresHonor: boolean;
  /** The total the booking would carry after a re-price. Null when re-pricing is not offered. */
  repriceTotal: number | null;
}

export interface TargetView {
  courtId: string;
  courtName: string;
  startsAt: string;
  endsAt: string;
  ok: boolean;
  reasons: MoveReason[];
  price: PriceView | null;
}

export interface MovePreview {
  booking: {
    id: string;
    source: string;
    courtId: string;
    courtName: string;
    startsAt: string;
    endsAt: string;
    durationMinutes: number;
    total: number;
    currency: string;
  };
  canMove: boolean;
  blocker: MoveBlocker | null;
  message: string | null;
  day: string;
  target: TargetView | null;
  sameUnit: TargetView[];
  otherUnits: TargetView[];
}

interface Evaluation extends TargetView {
  start: Date;
  end: Date;
  quote: { platform: number | null; manual: number | null };
}

/** Moves one booking to another time and/or unit. Never moves money. See MATCHENA_BOOKING_MOVE_DESIGN.md. */
@Injectable()
export class BookingMoveService {
  private readonly logger = new Logger(BookingMoveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerBookings: OwnerBookingsService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  private platformMoveEnabled(): boolean {
    return (
      (
        this.config.get<string>('BOOKING_MOVE_PLATFORM_ENABLED') ?? ''
      ).trim() === 'true'
    );
  }

  private async loadSource(db: Db, bookingId: string): Promise<Source> {
    const b = await db.booking.findUnique({
      where: { id: bookingId },
      include: BOOKING_LOAD,
    });
    if (!b) throw new NotFoundException('Booking not found');
    const { received } = await netReceived(db, bookingId);
    const durationMinutes = Math.round(
      (b.slotEnd.getTime() - b.slotStart.getTime()) / 60_000,
    );
    return {
      b,
      timeZone: b.venue.country.timezone,
      kind: b.court.sport?.activityKind ?? null,
      durationMinutes,
      received,
      facts: {
        source: b.source,
        status: b.status,
        paymentStatus: b.paymentStatus,
        checkedInAt: b.checkedInAt,
        hasSession: !!b.usageSession,
        recurringSeriesId: b.recurringSeriesId,
        bundleId: b.bundleId,
        membershipCovered: b.membershipCovered,
        hasPulse: !!b.pulseOpportunity || b.pulseClaims.length > 0,
        isSplitPayment: b.isSplitPayment,
        unsettledSplitShares: b.splitShares.length,
        openPaymentIntents: b.paymentIntents.length,
        slotStart: b.slotStart,
        platformMoveEnabled: this.platformMoveEnabled(),
        venueOperationsEnabled: b.venue.operationsEnabled,
      },
    };
  }

  /**
   * Everything about one destination that does not need the database, plus the price outcome.
   * `conflicts`: 'db' asks the database (authoritative), a list checks in memory (cheap pre-filter), 'skip' ignores clashes.
   */
  private async evaluate(
    db: Db | null,
    src: Source,
    court: LoadedCourt,
    start: Date,
    opts: {
      conflicts: 'db' | 'skip' | BusySpan[];
      price: boolean;
      now?: number;
    },
  ): Promise<Evaluation> {
    const now = opts.now ?? Date.now();
    const { b } = src;
    const end = new Date(start.getTime() + src.durationMinutes * 60_000);
    const base: Evaluation = {
      courtId: court.id,
      courtName: court.name,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      ok: false,
      reasons: [],
      price: null,
      start,
      end,
      quote: { platform: null, manual: null },
    };
    const reasons = new Set<MoveReason>();
    const finish = (): Evaluation => {
      base.reasons = REASON_ORDER.filter((r) => reasons.has(r));
      base.ok = base.reasons.length === 0;
      return base;
    };

    const platform = b.source === 'platform';
    if (
      court.venueId !== b.venueId ||
      (court.sport?.activityKind ?? null) !== src.kind ||
      (platform && court.sportId !== b.court.sportId)
    ) {
      reasons.add('UNIT_NOT_COMPATIBLE');
      return finish();
    }
    if (platform && court.gamingPublished === false)
      reasons.add('UNIT_NOT_BOOKABLE');
    if (court.id === b.courtId && start.getTime() === b.slotStart.getTime()) {
      reasons.add('NOTHING_TO_MOVE');
      return finish();
    }

    const minuteTiming = usesMinuteTiming(src.kind);
    if (!isWholeMinute(start)) {
      reasons.add('INVALID_SLOT_START');
      return finish();
    }
    if (isPastSlotStart(start, now)) reasons.add('SLOT_IN_PAST');
    if (tooFarAhead(start, now)) reasons.add('BOOKING_TOO_FAR_AHEAD');

    // Platform bookings follow the court's own slot grid and length, exactly like a new booking would.
    if (platform && !minuteTiming) {
      const dayStart = zonedDayBounds(
        zonedYmd(start, src.timeZone),
        src.timeZone,
      ).start;
      if (!onSlotGrid(start, dayStart, court.slotDurationMins))
        reasons.add('INVALID_SLOT_START');
      if (
        court.slotDurationMins < 1 ||
        src.durationMinutes % court.slotDurationMins !== 0
      )
        reasons.add('INVALID_DURATION');
    }

    const weeklyHours = b.venue.weeklyHours as WeeklyHours | null;
    if (!hasOpeningHours(weeklyHours)) reasons.add('VENUE_HOURS_REQUIRED');
    else if (
      !withinOpeningHours(
        weeklyHours,
        src.timeZone,
        start,
        end,
        minuteTiming ? 1 : 15,
      )
    )
      reasons.add('OUTSIDE_HOURS');

    if (opts.conflicts !== 'skip' && !reasons.has('INVALID_SLOT_START')) {
      if (Array.isArray(opts.conflicts)) {
        if (overlapsBusy(opts.conflicts, court.id, start, end))
          reasons.add('SLOT_ALREADY_HELD');
      } else if (db) {
        const clash = await this.ownerBookings.slotConflict(
          db,
          court.id,
          b.venueId,
          start,
          end,
          b.id,
        );
        if (clash) reasons.add(clash);
        if (platform) {
          const userClash = await db.booking.findFirst({
            where: {
              userId: b.userId,
              id: { not: b.id },
              status: { in: [...LIVE] },
              slotStart: { lt: end },
              slotEnd: { gt: start },
            },
            select: { id: true },
          });
          if (userClash) reasons.add('USER_TIME_CONFLICT');
        }
      }
    }

    if (opts.price) {
      const rules = court.pricingRules;
      const sameCurrency = rules.every((r) => r.currency === b.currency);
      let platformQuote: number | null = null;
      let manualQuote: number | null = null;
      if (sameCurrency && rules.length) {
        if (platform) {
          // Same formula as holdSlot: the rule covering the start times the number of slots; whole length must be priced.
          if (hasPricingCoverage(rules, start, end, src.timeZone)) {
            platformQuote = minuteTiming
              ? quoteDurationPrice(
                  rules,
                  start,
                  src.durationMinutes,
                  src.timeZone,
                  true,
                ).priceAmount
              : (() => {
                  const rule = coveringPricingRule(
                    rules,
                    zonedWeekday(start, src.timeZone),
                    start,
                    src.timeZone,
                  );
                  return rule
                    ? rule.priceAmount *
                        (src.durationMinutes / court.slotDurationMins)
                    : null;
                })();
          }
        } else {
          manualQuote = quoteDurationPrice(
            rules,
            start,
            src.durationMinutes,
            src.timeZone,
            minuteTiming,
          ).priceAmount;
        }
      }
      base.quote = { platform: platformQuote, manual: manualQuote };
      const verdict = priceVerdict({
        source: b.source,
        currentTotal: b.totalAmount,
        currentBase: b.baseAmount,
        received: src.received,
        platformQuote,
        manualQuote,
      });
      for (const r of verdict.reasons) reasons.add(r);
      base.price = {
        currentTotal: b.totalAmount,
        modes: verdict.modes,
        requiresHonor: verdict.requiresHonor,
        repriceTotal: verdict.modes.includes('reprice') ? manualQuote : null,
      };
    }
    return finish();
  }

  private view(e: Evaluation): TargetView {
    return {
      courtId: e.courtId,
      courtName: e.courtName,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      ok: e.ok,
      reasons: e.reasons,
      price: e.price,
    };
  }

  // ───────────────────────────── preview ─────────────────────────────

  async preview(
    user: AuthenticatedUser,
    bookingId: string,
    dto: MoveBookingPreviewDto,
  ): Promise<MovePreview> {
    await assertBookingAccess(this.prisma, user, bookingId, { write: false });
    await assertStaffPermission(this.prisma, user, 'bookings.edit');
    const src = await this.loadSource(this.prisma, bookingId);
    const { b } = src;
    const summary = {
      id: b.id,
      source: b.source,
      courtId: b.courtId,
      courtName: b.court.name,
      startsAt: b.slotStart.toISOString(),
      endsAt: b.slotEnd.toISOString(),
      durationMinutes: src.durationMinutes,
      total: b.totalAmount,
      currency: b.currency,
    };
    const blocker = moveBlocker(src.facts);
    if (dto.date !== undefined && !isRealDate(dto.date)) {
      throw new BadRequestException({
        code: 'INVALID_SLOT_START',
        message: 'That date does not exist',
      });
    }
    if (
      (dto.startsAt !== undefined &&
        !Number.isFinite(Date.parse(dto.startsAt))) ||
      !!dto.courtId !== !!dto.startsAt
    ) {
      throw new BadRequestException({
        code: 'INVALID_SLOT_START',
        message: 'Send both a unit and a start, or neither',
      });
    }
    const day = dto.date ?? zonedYmd(b.slotStart, src.timeZone);
    if (blocker) {
      return {
        booking: summary,
        canMove: false,
        blocker,
        message: MESSAGE[blocker],
        day,
        target: null,
        sameUnit: [],
        otherUnits: [],
      };
    }

    const now = Date.now();
    const courts = await this.prisma.court.findMany({
      where: {
        venueId: b.venueId,
        sport: { activityKind: src.kind },
        ...(b.source === 'platform'
          ? { sportId: b.court.sportId, gamingPublished: true }
          : {}),
      },
      include: COURT_LOAD,
      orderBy: { name: 'asc' },
      take: MAX_UNITS,
    });
    if (!courts.some((c) => c.id === b.courtId)) {
      const own = await this.prisma.court.findUnique({
        where: { id: b.courtId },
        include: COURT_LOAD,
      });
      if (own) courts.push(own);
    }
    const byId = new Map(courts.map((c) => [c.id, c]));

    let target: TargetView | null = null;
    if (dto.courtId && dto.startsAt) {
      const court =
        byId.get(dto.courtId) ??
        (await this.prisma.court.findUnique({
          where: { id: dto.courtId },
          include: COURT_LOAD,
        }));
      // A unit of another venue is reported exactly like an incompatible one: nothing about it is revealed.
      if (!court) throw new NotFoundException('Court not found');
      target = this.view(
        await this.evaluate(this.prisma, src, court, new Date(dto.startsAt), {
          conflicts: 'db',
          price: true,
          now,
        }),
      );
    }

    const { start: dayStart, end: dayEnd } = zonedDayBounds(day, src.timeZone);
    const bookingDayStart = zonedDayBounds(
      zonedYmd(b.slotStart, src.timeZone),
      src.timeZone,
    ).start;
    const anchor = new Date(
      dayStart.getTime() + (b.slotStart.getTime() - bookingDayStart.getTime()),
    );

    const busy = await this.loadBusy(
      courts.map((c) => c.id),
      b.venueId,
      new Date(dayStart.getTime() - 12 * 3_600_000),
      new Date(dayEnd.getTime() + src.durationMinutes * 60_000),
      b.id,
    );

    // Pass 1 (cheap, in memory, no pricing): which starts are possible at all.
    const own = byId.get(b.courtId)!;
    const stepOf = (c: LoadedCourt) =>
      b.source === 'platform' && !usesMinuteTiming(src.kind)
        ? c.slotDurationMins
        : Math.max(15, Math.min(c.slotDurationMins, 30));
    const sameStarts = candidateStarts(dayStart, dayEnd, stepOf(own));
    const sameOk: Evaluation[] = [];
    for (const s of sameStarts) {
      const e = await this.evaluate(null, src, own, s, {
        conflicts: busy,
        price: false,
        now,
      });
      if (e.ok) sameOk.push(e);
    }
    const otherOk: Evaluation[] = [];
    for (const c of courts) {
      if (c.id === b.courtId) continue;
      const e = await this.evaluate(null, src, c, anchor, {
        conflicts: busy,
        price: false,
        now,
      });
      if (e.ok) otherOk.push(e);
    }

    // Pass 2 (authoritative, with price): only the few finalists we will actually show.
    const finalists = async (
      list: Evaluation[],
      rank: (x: Evaluation[]) => Evaluation[],
    ) => {
      const out: TargetView[] = [];
      for (const cand of rank(list)) {
        if (out.length >= PER_GROUP) break;
        const court = byId.get(cand.courtId)!;
        const e = await this.evaluate(this.prisma, src, court, cand.start, {
          conflicts: 'db',
          price: true,
          now,
        });
        if (e.ok) out.push(this.view(e));
      }
      return out;
    };
    const sameUnit = await finalists(sameOk, (x) =>
      nearestFirst(x, anchor, (e) => e.start),
    );
    const otherUnits = await finalists(otherOk, (x) => x);

    return {
      booking: summary,
      canMove: true,
      blocker: null,
      message: null,
      day,
      target,
      sameUnit,
      otherUnits,
    };
  }

  /** Spans where each unit is already taken in the window, for the in-memory pre-filter. */
  private async loadBusy(
    courtIds: string[],
    venueId: string,
    from: Date,
    to: Date,
    exceptBookingId: string,
  ): Promise<BusySpan[]> {
    const [bookings, occupancies, blocks] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          courtId: { in: courtIds },
          id: { not: exceptBookingId },
          status: { in: [...LIVE] },
          slotStart: { lt: to },
          slotEnd: { gt: from },
        },
        select: { courtId: true, slotStart: true, slotEnd: true },
        take: 5000,
      }),
      this.prisma.resourceOccupancy.findMany({
        where: {
          resourceId: { in: courtIds },
          NOT: { bookingId: exceptBookingId },
          startsAt: { lt: to },
          OR: [{ endsAt: null }, { endsAt: { gt: from } }],
        },
        select: { resourceId: true, startsAt: true, endsAt: true },
        take: 5000,
      }),
      this.prisma.calendarBlock.findMany({
        where: {
          venueId,
          startsAt: { lt: to },
          endsAt: { gt: from },
          OR: [{ courtId: { in: courtIds } }, { courtId: null }],
        },
        select: { courtId: true, startsAt: true, endsAt: true },
        take: 2000,
      }),
    ]);
    const out: BusySpan[] = [
      ...bookings.map((x) => ({
        courtId: x.courtId,
        from: x.slotStart,
        to: x.slotEnd,
      })),
      ...occupancies.map((x) => ({
        courtId: x.resourceId,
        from: x.startsAt,
        to: x.endsAt,
      })),
    ];
    for (const blk of blocks) {
      for (const id of blk.courtId ? [blk.courtId] : courtIds)
        out.push({ courtId: id, from: blk.startsAt, to: blk.endsAt });
    }
    return out;
  }

  // ─────────────────────────────── move ───────────────────────────────

  async move(user: AuthenticatedUser, bookingId: string, dto: MoveBookingDto) {
    const { booking: head } = await assertBookingAccess(
      this.prisma,
      user,
      bookingId,
      { write: true },
    );
    await assertStaffPermission(this.prisma, user, 'bookings.edit');
    if (dto.honorOriginalPrice)
      await assertStaffPermission(this.prisma, user, 'pricing.manage');

    const requestKey = dto.requestKey.toLowerCase();
    const start = new Date(dto.startsAt);
    const fromStart = new Date(dto.fromStartsAt);
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(fromStart.getTime())
    )
      refuse('INVALID_SLOT_START');
    const priceMode = dto.priceMode ?? 'keep';
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          bookingId,
          from: [dto.fromCourtId, fromStart.toISOString()],
          to: [dto.courtId, start.toISOString()],
          priceMode,
          honor: !!dto.honorOriginalPrice,
        }),
      )
      .digest('hex');

    const replayed = await this.replay(user, requestKey, hash, bookingId);
    if (replayed) return replayed;

    // Cheap refusals before any lock is taken: a stale screen, or a unit that is not this venue's.
    if (
      dto.fromCourtId !== head.courtId ||
      fromStart.getTime() !== head.slotStart.getTime()
    ) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'BOOKING_CHANGED',
        'This booking changed. Refresh and try again',
      );
    }
    const target = await this.prisma.court.findUnique({
      where: { id: dto.courtId },
      select: { venueId: true },
    });
    if (!target || target.venueId !== head.venueId)
      refuse('UNIT_NOT_COMPATIBLE');

    let moved: {
      fromCourtId: string;
      fromStart: Date;
      fromEnd: Date;
      priceChanged: boolean;
      previousTotal: number;
      newTotal: number;
    };
    try {
      moved = await this.prisma.$transaction(
        async (tx) => {
          await lockVenueSlots(tx, head.venueId);
          const ids = [...new Set([dto.fromCourtId, dto.courtId])].sort();
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM "Court" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`,
          );
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM "Booking" WHERE id = ${bookingId} FOR UPDATE`,
          );

          const src = await this.loadSource(tx, bookingId);
          const { b } = src;
          if (
            b.courtId !== dto.fromCourtId ||
            b.slotStart.getTime() !== fromStart.getTime()
          ) {
            throw new ApiException(
              HttpStatus.CONFLICT,
              'BOOKING_CHANGED',
              'This booking changed. Refresh and try again',
            );
          }
          const blocker = moveBlocker(src.facts);
          if (blocker) refuse(blocker);

          const court = await tx.court.findUnique({
            where: { id: dto.courtId },
            include: COURT_LOAD,
          });
          if (!court || court.venueId !== b.venueId)
            refuse('UNIT_NOT_COMPATIBLE');
          const ev = await this.evaluate(tx, src, court, start, {
            conflicts: 'db',
            price: true,
          });
          if (!ev.ok) refuse(ev.reasons[0]);
          const price = ev.price!;
          if (priceMode === 'reprice' && !price.modes.includes('reprice')) {
            throw new ApiException(
              HttpStatus.CONFLICT,
              'PRICE_MODE_NOT_ALLOWED',
              'Re-pricing is not available for this move',
            );
          }
          if (price.requiresHonor && !dto.honorOriginalPrice) {
            throw new ApiException(
              HttpStatus.CONFLICT,
              'PRICE_HIGHER_NEEDS_APPROVAL',
              'The new time costs more. Confirm that the player keeps the price they paid',
            );
          }

          const data: Prisma.BookingUpdateInput = {
            slotStart: ev.start,
            slotEnd: ev.end,
          };
          if (court.id !== b.courtId)
            data.court = { connect: { id: court.id } };
          let newTotal = b.totalAmount;
          if (priceMode === 'reprice' && price.repriceTotal !== null) {
            newTotal = price.repriceTotal;
            data.baseAmount = newTotal;
            data.totalAmount = newTotal;
            data.paymentStatus = derivePaymentStatus(newTotal, src.received);
          }
          await tx.booking.update({ where: { id: bookingId }, data });
          if (newTotal !== b.totalAmount)
            await this.ledger.syncBookingLedger(tx, bookingId, 'moved_reprice');

          if (b.source === 'manual')
            await this.refreshCollectionReminders(
              tx,
              b.venue.ownerId,
              bookingId,
              requestKey,
            );
          else {
            // "Your game starts soon" is sent once per booking; retire the one for the old time so the new time gets its own.
            await tx.notification.updateMany({
              where: { dedupKey: `booking-reminder-player:${bookingId}` },
              data: {
                dedupKey: `booking-reminder-player:${bookingId}:moved:${requestKey}`,
              },
            });
          }

          await tx.auditLogEntry.create({
            data: {
              id: requestKey,
              actorUserId: user.id,
              action: 'owner.booking.moved',
              targetType: 'booking',
              targetId: bookingId,
              metadata: {
                bookingId,
                venueId: b.venueId,
                code: b.code,
                source: b.source,
                requestHash: hash,
                from: {
                  courtId: b.courtId,
                  startsAt: b.slotStart.toISOString(),
                  endsAt: b.slotEnd.toISOString(),
                },
                to: {
                  courtId: court.id,
                  startsAt: ev.start.toISOString(),
                  endsAt: ev.end.toISOString(),
                },
                priceMode,
                honorOriginalPrice:
                  !!dto.honorOriginalPrice && price.requiresHonor,
                previousTotal: b.totalAmount,
                newTotal,
              },
            },
          });
          return {
            fromCourtId: b.courtId,
            fromStart: b.slotStart,
            fromEnd: b.slotEnd,
            priceChanged: newTotal !== b.totalAmount,
            previousTotal: b.totalAmount,
            newTotal,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      const again = await this.replay(user, requestKey, hash, bookingId).catch(
        () => null,
      );
      if (again) return again;
      throw this.translate(error);
    }

    const fresh = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
    });
    await this.tellPlayer(fresh, start, requestKey).catch((error: unknown) =>
      this.logger.warn(`Move notice failed for ${bookingId}: ${String(error)}`),
    );
    return {
      booking: await this.ownerBookings.toOwnerBookingDto(fresh, user),
      moved: {
        from: {
          courtId: moved.fromCourtId,
          startsAt: moved.fromStart.toISOString(),
          endsAt: moved.fromEnd.toISOString(),
        },
        priceChanged: moved.priceChanged,
        previousTotal: moved.previousTotal,
        newTotal: moved.newTotal,
      },
      replayed: false,
      serverNow: new Date().toISOString(),
    };
  }

  /** The same request key again returns what the first one did; the same key with a different request is refused. */
  private async replay(
    user: AuthenticatedUser,
    requestKey: string,
    hash: string,
    bookingId: string,
  ) {
    const event = await this.prisma.auditLogEntry.findUnique({
      where: { id: requestKey },
    });
    if (!event) return null;
    const meta = (event.metadata ?? {}) as Record<string, unknown>;
    if (
      event.actorUserId !== user.id ||
      event.action !== 'owner.booking.moved' ||
      event.targetId !== bookingId ||
      meta['requestHash'] !== hash
    ) {
      throw new ConflictException({
        code: 'OPERATION_KEY_REUSED',
        message: 'This request identity was used for a different request',
      });
    }
    const fresh = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
    });
    const from = (meta['from'] ?? {}) as {
      courtId?: string;
      startsAt?: string;
      endsAt?: string;
    };
    return {
      booking: await this.ownerBookings.toOwnerBookingDto(fresh, user),
      moved: {
        from: {
          courtId: from.courtId ?? null,
          startsAt: from.startsAt ?? null,
          endsAt: from.endsAt ?? null,
        },
        priceChanged: meta['previousTotal'] !== meta['newTotal'],
        previousTotal: meta['previousTotal'] ?? null,
        newTotal: meta['newTotal'] ?? null,
      },
      replayed: true,
      serverNow: new Date().toISOString(),
    };
  }

  /**
   * The collection reminders are sent once per booking. After a move the booking has a new time and
   * deserves its own reminders, so earlier ones are retired by renaming their key (the notices stay).
   */
  private async refreshCollectionReminders(
    tx: Prisma.TransactionClient,
    ownerId: string,
    bookingId: string,
    requestKey: string,
  ) {
    const rows = await tx.notification.findMany({
      where: {
        userId: ownerId,
        OR: [
          { payload: { path: ['paymentReminderFor'], equals: bookingId } },
          { payload: { path: ['endingUnpaidFor'], equals: bookingId } },
        ],
      },
      select: { id: true, payload: true },
      take: 20,
    });
    for (const row of rows) {
      const p = { ...((row.payload ?? {}) as Record<string, unknown>) };
      for (const key of ['paymentReminderFor', 'endingUnpaidFor']) {
        if (p[key] === bookingId) p[key] = `${bookingId}#moved:${requestKey}`;
      }
      await tx.notification.update({
        where: { id: row.id },
        data: { payload: p as Prisma.InputJsonValue },
      });
    }
  }

  private async tellPlayer(
    b: {
      id: string;
      source: string;
      userId: string;
      venueId: string;
      courtId: string;
      slotStart: Date;
    },
    start: Date,
    requestKey: string,
  ) {
    if (b.source !== 'platform') return;
    const [venue, court] = await Promise.all([
      this.prisma.venue.findUnique({
        where: { id: b.venueId },
        select: {
          nameEn: true,
          nameAr: true,
          country: { select: { timezone: true } },
        },
      }),
      this.prisma.court.findUnique({
        where: { id: b.courtId },
        select: { name: true },
      }),
    ]);
    if (!venue) return;
    const tz = venue.country.timezone;
    const when = (lang: 'en-GB' | 'ar-EG-u-nu-latn') =>
      new Intl.DateTimeFormat(lang, {
        timeZone: tz,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(start);
    await this.notifications.create({
      dedupKey: `booking-moved:${b.id}:${requestKey}`,
      userId: b.userId,
      category: 'bookings',
      titleEn: 'Your booking time changed',
      titleAr: 'تم تغيير موعد حجزك',
      bodyEn: `${venue.nameEn} moved your booking to ${when('en-GB')}${court ? ` on ${court.name}` : ''}. Nothing changes in what you paid.`,
      bodyAr: `${venue.nameAr} نقل حجزك إلى ${when('ar-EG-u-nu-latn')}${court ? ` على ${court.name}` : ''}. لا يتغير شيء في المبلغ الذي دفعته.`,
      deepLink: '/app/bookings',
      payload: { kind: 'booking_moved', bookingId: b.id, venueId: b.venueId },
    });
  }

  private translate(error: unknown): unknown {
    if (error instanceof HttpException) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Booking_user_slot_range_excl'))
      return new ApiException(
        HttpStatus.CONFLICT,
        'USER_TIME_CONFLICT',
        MESSAGE['USER_TIME_CONFLICT'],
      );
    if (
      message.includes('23P01') ||
      message.includes('Booking_court_slot_range_excl') ||
      message.includes('ResourceOccupancy_') ||
      message.includes('RESOURCE_IN_USE')
    ) {
      return new ApiException(
        HttpStatus.CONFLICT,
        'SLOT_ALREADY_HELD',
        MESSAGE['SLOT_ALREADY_HELD'],
      );
    }
    if (message.includes('BOOKING_LINKED_TO_SESSION'))
      return new ApiException(
        HttpStatus.CONFLICT,
        'BOOKING_HAS_SESSION',
        MESSAGE['BOOKING_HAS_SESSION'],
      );
    if (
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || error.code === 'P2002')) ||
      message.includes('40001') ||
      message.includes('40P01') ||
      message.includes('could not serialize')
    ) {
      return new ApiException(
        HttpStatus.CONFLICT,
        'CONCURRENT_CHANGE',
        'This booking changed while you were moving it. Refresh and try again',
      );
    }
    this.logger.error(`Unexpected move failure: ${message}`);
    return error;
  }
}
