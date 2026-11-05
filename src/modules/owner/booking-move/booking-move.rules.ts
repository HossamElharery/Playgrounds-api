import { isPastSlotStart } from '../../../common/utils/past-slot.util';
import {
  isTimeWithinDayHours,
  type WeeklyHours,
} from '../../../common/utils/weekly-hours.util';

/**
 * Pure rules for moving a booking to another time or unit. No database, no clock of its own:
 * everything a decision depends on is passed in, so every rule can be tested on its own and the
 * preview (what the owner sees) and the move (what actually happens) cannot drift apart.
 */

export const MAX_ADVANCE_DAYS = 90;
export const MOVE_MAX_AGE_MS = 90 * 86_400_000;

/** Why THIS booking cannot be moved at all, whatever the destination. */
export type MoveBlocker =
  | 'BOOKING_NOT_MOVABLE_STATUS'
  | 'BOOKING_CHECKED_IN'
  | 'BOOKING_HAS_SESSION'
  | 'BOOKING_IN_SERIES'
  | 'BOOKING_IN_BUNDLE'
  | 'BOOKING_MEMBERSHIP'
  | 'BOOKING_PULSE'
  | 'BOOKING_SPLIT_PENDING'
  | 'BOOKING_PAYMENT_PENDING'
  | 'BOOKING_PAYMENT_STATE'
  | 'BOOKING_STARTED'
  | 'BOOKING_TOO_OLD'
  | 'PLATFORM_MOVE_DISABLED'
  | 'VENUE_OPERATIONS_PAUSED';

/** Why THIS destination does not work. Several can apply at once. */
export type MoveReason =
  | 'NOTHING_TO_MOVE'
  | 'UNIT_NOT_COMPATIBLE'
  | 'UNIT_NOT_BOOKABLE'
  | 'SLOT_IN_PAST'
  | 'BOOKING_TOO_FAR_AHEAD'
  | 'INVALID_SLOT_START'
  | 'INVALID_DURATION'
  | 'VENUE_HOURS_REQUIRED'
  | 'OUTSIDE_HOURS'
  | 'PRICE_REQUIRED'
  | 'PRICE_LOWER_USE_REFUND'
  | 'SLOT_ALREADY_HELD'
  | 'SLOT_BLOCKED'
  | 'USER_TIME_CONFLICT';

export interface MoveSourceFacts {
  source: 'platform' | 'manual';
  status: string;
  paymentStatus: string;
  checkedInAt: Date | null;
  hasSession: boolean;
  recurringSeriesId: string | null;
  bundleId: string | null;
  membershipCovered: boolean;
  hasPulse: boolean;
  isSplitPayment: boolean;
  unsettledSplitShares: number;
  /** Card checkouts that are open or being reconciled (created, pending, refund_pending, needs_review). */
  openPaymentIntents: number;
  slotStart: Date;
  platformMoveEnabled: boolean;
  venueOperationsEnabled: boolean;
}

/** First reason this booking cannot be moved, or null when it can. Order = what the owner should fix first. */
export function moveBlocker(
  f: MoveSourceFacts,
  now: number = Date.now(),
): MoveBlocker | null {
  if (f.venueOperationsEnabled === false) return 'VENUE_OPERATIONS_PAUSED';
  if (f.source === 'platform' && !f.platformMoveEnabled)
    return 'PLATFORM_MOVE_DISABLED';
  if (f.status !== 'confirmed') return 'BOOKING_NOT_MOVABLE_STATUS';
  if (f.checkedInAt) return 'BOOKING_CHECKED_IN';
  if (f.hasSession) return 'BOOKING_HAS_SESSION';
  if (f.recurringSeriesId) return 'BOOKING_IN_SERIES';
  if (f.bundleId) return 'BOOKING_IN_BUNDLE';
  if (f.membershipCovered) return 'BOOKING_MEMBERSHIP';
  if (f.hasPulse) return 'BOOKING_PULSE';
  if (f.isSplitPayment && f.unsettledSplitShares > 0)
    return 'BOOKING_SPLIT_PENDING';
  if (f.openPaymentIntents > 0) return 'BOOKING_PAYMENT_PENDING';
  if (f.paymentStatus === 'refunded' || f.paymentStatus === 'failed')
    return 'BOOKING_PAYMENT_STATE';
  if (now - f.slotStart.getTime() > MOVE_MAX_AGE_MS) return 'BOOKING_TOO_OLD';
  // Once it has started it is an attendance question (came / did not come), not a reschedule.
  if (isPastSlotStart(f.slotStart, now)) return 'BOOKING_STARTED';
  return null;
}

/** A start must be a whole minute. Sub-minute offsets would slip past every grid and hours check. */
export function isWholeMinute(d: Date): boolean {
  return Number.isFinite(d.getTime()) && d.getTime() % 60_000 === 0;
}

/** `start` sits on the unit's slot grid, counted from the venue-local start of that day (same rule as holdSlot). */
export function onSlotGrid(
  start: Date,
  dayStart: Date,
  stepMins: number,
): boolean {
  if (!Number.isSafeInteger(stepMins) || stepMins < 1) return false;
  return (start.getTime() - dayStart.getTime()) % (stepMins * 60_000) === 0;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Weekday (0 = Sunday) and "HH:mm" of an instant on a venue's clock. Same answer as
 * zonedWeekday/zonedHhmm, but the formatter is built once per time zone: a one-minute scan of a
 * long booking calls this thousands of times and building a formatter each time is slow.
 */
export function localClock(
  instant: Date,
  timeZone: string,
): { day: number; hhmm: string } {
  let fmt = clockFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    clockFormatters.set(timeZone, fmt);
  }
  let weekday = '';
  let hour = '00';
  let minute = '00';
  for (const p of fmt.formatToParts(instant)) {
    if (p.type === 'weekday') weekday = p.value;
    else if (p.type === 'hour') hour = p.value;
    else if (p.type === 'minute') minute = p.value;
  }
  return {
    day: WEEKDAY[weekday] ?? instant.getUTCDay(),
    hhmm: `${hour === '24' ? '00' : hour}:${minute}`,
  };
}

/** Every `stepMinutes` of [start, end) falls inside the venue's opening hours on its own clock. */
export function withinOpeningHours(
  weeklyHours: WeeklyHours | null | undefined,
  timeZone: string,
  start: Date,
  end: Date,
  stepMinutes: number,
): boolean {
  if (
    !weeklyHours ||
    !(end > start) ||
    !Number.isSafeInteger(stepMinutes) ||
    stepMinutes < 1
  )
    return false;
  for (
    let at = start.getTime();
    at < end.getTime();
    at += stepMinutes * 60_000
  ) {
    const { day, hhmm } = localClock(new Date(at), timeZone);
    const hours =
      weeklyHours[String(day)] ??
      (weeklyHours as Record<string, never>)[day as unknown as string];
    if (!isTimeWithinDayHours(hhmm, hours)) return false;
  }
  return true;
}

export interface PriceVerdict {
  /** Priced reasons that make the destination unusable. */
  reasons: Array<'PRICE_REQUIRED' | 'PRICE_LOWER_USE_REFUND'>;
  /** What the owner may choose for the booking's price at the destination. */
  modes: Array<'keep' | 'reprice'>;
  /** Platform bookings only: the destination is dearer, so keeping the player's price needs the owner's explicit say-so. */
  requiresHonor: boolean;
}

/**
 * Money rules. The move never moves money: it either keeps the total, or (manual bookings only)
 * re-prices to the destination's schedule when nothing already received would exceed it.
 * A platform booking is paid at the price the player agreed: dearer destination = the venue may
 * honour the old price on purpose; cheaper destination = refuse, that is a refund, not a move.
 */
export function priceVerdict(i: {
  source: 'platform' | 'manual';
  currentTotal: number;
  currentBase: number;
  received: number;
  /** Platform formula (holdSlot): rule price at the start times units. Null = no price. */
  platformQuote: number | null;
  /** Manual formula (price-quote endpoint): per-15-minute weighted. Null = no price. */
  manualQuote: number | null;
}): PriceVerdict {
  if (i.source === 'platform') {
    if (i.platformQuote === null)
      return { reasons: ['PRICE_REQUIRED'], modes: [], requiresHonor: false };
    if (i.platformQuote < i.currentBase)
      return {
        reasons: ['PRICE_LOWER_USE_REFUND'],
        modes: [],
        requiresHonor: false,
      };
    return {
      reasons: [],
      modes: ['keep'],
      requiresHonor: i.platformQuote > i.currentBase,
    };
  }
  const modes: Array<'keep' | 'reprice'> = ['keep'];
  if (
    i.manualQuote !== null &&
    i.manualQuote !== i.currentTotal &&
    i.received <= i.manualQuote
  )
    modes.push('reprice');
  return { reasons: [], modes, requiresHonor: false };
}

export interface BusySpan {
  courtId: string;
  from: Date;
  /** Null = open ended (a running session). */
  to: Date | null;
}

export function overlapsBusy(
  busy: BusySpan[],
  courtId: string,
  start: Date,
  end: Date,
): boolean {
  return busy.some(
    (b) =>
      b.courtId === courtId && b.from < end && (b.to === null || b.to > start),
  );
}

/** Every grid start of one venue-local day: [dayStart, dayEnd) in `stepMinutes` steps. */
export function candidateStarts(
  dayStart: Date,
  dayEnd: Date,
  stepMinutes: number,
): Date[] {
  const out: Date[] = [];
  if (!Number.isSafeInteger(stepMinutes) || stepMinutes < 1) return out;
  for (
    let at = dayStart.getTime();
    at < dayEnd.getTime();
    at += stepMinutes * 60_000
  )
    out.push(new Date(at));
  return out;
}

/** Closest first to the time the booking has now; ties go to the later start (it cannot be in the past by accident). */
export function nearestFirst<T>(
  items: T[],
  anchor: Date,
  at: (item: T) => Date,
): T[] {
  return [...items].sort((a, b) => {
    const da = Math.abs(at(a).getTime() - anchor.getTime());
    const db = Math.abs(at(b).getTime() - anchor.getTime());
    return da - db || at(b).getTime() - at(a).getTime();
  });
}

export function tooFarAhead(start: Date, now: number = Date.now()): boolean {
  return start.getTime() > now + MAX_ADVANCE_DAYS * 86_400_000;
}
