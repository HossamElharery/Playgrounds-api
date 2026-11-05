import {
  zonedDayBounds,
  zonedHhmm,
  zonedWeekday,
} from '../../../common/utils/timezone.util';
import {
  MOVE_MAX_AGE_MS,
  candidateStarts,
  isWholeMinute,
  localClock,
  moveBlocker,
  nearestFirst,
  onSlotGrid,
  overlapsBusy,
  priceVerdict,
  tooFarAhead,
  withinOpeningHours,
  type MoveSourceFacts,
} from './booking-move.rules';

const NOW = Date.parse('2026-11-05T10:00:00Z');
const HOUR = 3_600_000;
const facts = (patch: Partial<MoveSourceFacts> = {}): MoveSourceFacts => ({
  source: 'manual',
  status: 'confirmed',
  paymentStatus: 'pending',
  checkedInAt: null,
  hasSession: false,
  recurringSeriesId: null,
  bundleId: null,
  membershipCovered: false,
  hasPulse: false,
  isSplitPayment: false,
  unsettledSplitShares: 0,
  openPaymentIntents: 0,
  slotStart: new Date(NOW + 5 * HOUR),
  platformMoveEnabled: true,
  venueOperationsEnabled: true,
  ...patch,
});

describe('moveBlocker', () => {
  it('lets a plain future confirmed booking move', () => {
    expect(moveBlocker(facts(), NOW)).toBeNull();
    expect(
      moveBlocker(facts({ source: 'platform', paymentStatus: 'paid' }), NOW),
    ).toBeNull();
  });

  it.each([
    ['status held', { status: 'held' }, 'BOOKING_NOT_MOVABLE_STATUS'],
    ['status cancelled', { status: 'cancelled' }, 'BOOKING_NOT_MOVABLE_STATUS'],
    ['status completed', { status: 'completed' }, 'BOOKING_NOT_MOVABLE_STATUS'],
    ['status no_show', { status: 'no_show' }, 'BOOKING_NOT_MOVABLE_STATUS'],
    ['checked in', { checkedInAt: new Date(NOW) }, 'BOOKING_CHECKED_IN'],
    ['running session', { hasSession: true }, 'BOOKING_HAS_SESSION'],
    ['fixed series', { recurringSeriesId: 's1' }, 'BOOKING_IN_SERIES'],
    ['bundle', { bundleId: 'b1' }, 'BOOKING_IN_BUNDLE'],
    ['membership hours', { membershipCovered: true }, 'BOOKING_MEMBERSHIP'],
    ['last-minute offer', { hasPulse: true }, 'BOOKING_PULSE'],
    [
      'unsettled split',
      { isSplitPayment: true, unsettledSplitShares: 2 },
      'BOOKING_SPLIT_PENDING',
    ],
    [
      'open card checkout',
      { openPaymentIntents: 1 },
      'BOOKING_PAYMENT_PENDING',
    ],
    ['refunded', { paymentStatus: 'refunded' }, 'BOOKING_PAYMENT_STATE'],
    ['failed payment', { paymentStatus: 'failed' }, 'BOOKING_PAYMENT_STATE'],
    [
      'ops paused',
      { venueOperationsEnabled: false },
      'VENUE_OPERATIONS_PAUSED',
    ],
  ] as const)('refuses %s', (_label, patch, expected) => {
    expect(moveBlocker(facts(patch as Partial<MoveSourceFacts>), NOW)).toBe(
      expected,
    );
  });

  it('a fully paid split is fine', () => {
    expect(
      moveBlocker(
        facts({ isSplitPayment: true, unsettledSplitShares: 0 }),
        NOW,
      ),
    ).toBeNull();
  });

  it('Matchena bookings need the switch', () => {
    expect(
      moveBlocker(
        facts({ source: 'platform', platformMoveEnabled: false }),
        NOW,
      ),
    ).toBe('PLATFORM_MOVE_DISABLED');
    expect(
      moveBlocker(facts({ source: 'manual', platformMoveEnabled: false }), NOW),
    ).toBeNull();
  });

  it('refuses once the booking time has started (past the 15 minute grace)', () => {
    expect(
      moveBlocker(facts({ slotStart: new Date(NOW - 10 * 60_000) }), NOW),
    ).toBeNull();
    expect(
      moveBlocker(facts({ slotStart: new Date(NOW - 20 * 60_000) }), NOW),
    ).toBe('BOOKING_STARTED');
  });

  it('refuses a booking older than 90 days before saying "started"', () => {
    expect(
      moveBlocker(
        facts({ slotStart: new Date(NOW - MOVE_MAX_AGE_MS - HOUR) }),
        NOW,
      ),
    ).toBe('BOOKING_TOO_OLD');
  });

  it('reports the venue pause before anything else', () => {
    expect(
      moveBlocker(
        facts({
          venueOperationsEnabled: false,
          status: 'cancelled',
          hasSession: true,
        }),
        NOW,
      ),
    ).toBe('VENUE_OPERATIONS_PAUSED');
  });
});

describe('priceVerdict', () => {
  const base = {
    currentTotal: 42000,
    currentBase: 40000,
    received: 0,
    platformQuote: null as number | null,
    manualQuote: null as number | null,
  };

  it('Matchena: same price moves, dearer needs approval, cheaper is a refund, no price is refused', () => {
    expect(
      priceVerdict({ ...base, source: 'platform', platformQuote: 40000 }),
    ).toEqual({ reasons: [], modes: ['keep'], requiresHonor: false });
    expect(
      priceVerdict({ ...base, source: 'platform', platformQuote: 55000 }),
    ).toEqual({ reasons: [], modes: ['keep'], requiresHonor: true });
    expect(
      priceVerdict({ ...base, source: 'platform', platformQuote: 39999 }),
    ).toEqual({
      reasons: ['PRICE_LOWER_USE_REFUND'],
      modes: [],
      requiresHonor: false,
    });
    expect(
      priceVerdict({ ...base, source: 'platform', platformQuote: null }),
    ).toEqual({ reasons: ['PRICE_REQUIRED'], modes: [], requiresHonor: false });
  });

  it('Matchena never offers re-pricing, whatever the schedule says', () => {
    for (const q of [1, 40000, 99999])
      expect(
        priceVerdict({ ...base, source: 'platform', platformQuote: q }).modes,
      ).not.toContain('reprice');
  });

  it('manual: keep always works, even with no schedule price', () => {
    expect(
      priceVerdict({ ...base, source: 'manual', manualQuote: null }),
    ).toEqual({ reasons: [], modes: ['keep'], requiresHonor: false });
  });

  it('manual: re-pricing only when the price differs and nothing received exceeds it', () => {
    expect(
      priceVerdict({ ...base, source: 'manual', manualQuote: 50000 }).modes,
    ).toEqual(['keep', 'reprice']);
    expect(
      priceVerdict({ ...base, source: 'manual', manualQuote: 42000 }).modes,
    ).toEqual(['keep']);
    expect(
      priceVerdict({
        ...base,
        source: 'manual',
        manualQuote: 30000,
        received: 30000,
      }).modes,
    ).toEqual(['keep', 'reprice']);
    expect(
      priceVerdict({
        ...base,
        source: 'manual',
        manualQuote: 30000,
        received: 30001,
      }).modes,
    ).toEqual(['keep']);
  });

  it('manual: a zero price is a real price, not "missing"', () => {
    expect(
      priceVerdict({ ...base, source: 'manual', manualQuote: 0 }).modes,
    ).toEqual(['keep', 'reprice']);
  });
});

describe('time helpers', () => {
  it('whole minute only', () => {
    expect(isWholeMinute(new Date('2026-11-06T18:00:00.000Z'))).toBe(true);
    expect(isWholeMinute(new Date('2026-11-06T18:00:30.000Z'))).toBe(false);
    expect(isWholeMinute(new Date('2026-11-06T18:00:00.001Z'))).toBe(false);
    expect(isWholeMinute(new Date('nope'))).toBe(false);
  });

  it('slot grid is counted from the venue-local day start', () => {
    const { start } = zonedDayBounds('2026-11-06', 'Africa/Cairo');
    expect(onSlotGrid(new Date(start.getTime() + 18 * HOUR), start, 60)).toBe(
      true,
    );
    expect(onSlotGrid(new Date(start.getTime() + 18.5 * HOUR), start, 60)).toBe(
      false,
    );
    expect(onSlotGrid(new Date(start.getTime() + 18.5 * HOUR), start, 90)).toBe(
      false,
    );
    expect(onSlotGrid(new Date(start.getTime() + 18 * HOUR), start, 90)).toBe(
      true,
    );
    expect(onSlotGrid(start, start, 0)).toBe(false);
    expect(onSlotGrid(start, start, 1.5)).toBe(false);
  });

  it('localClock agrees with the project time helpers in several zones, across midnight and DST', () => {
    const zones = [
      'Africa/Cairo',
      'Asia/Riyadh',
      'Asia/Dubai',
      'Africa/Tripoli',
      'America/New_York',
      'Pacific/Auckland',
    ];
    for (const tz of zones) {
      for (let h = 0; h < 24 * 14; h += 7) {
        const t = new Date(
          Date.parse('2026-03-01T00:00:00Z') + h * HOUR + 11 * 60_000,
        );
        expect(localClock(t, tz)).toEqual({
          day: zonedWeekday(t, tz),
          hhmm: zonedHhmm(t, tz),
        });
      }
      for (let h = 0; h < 24 * 14; h += 13) {
        const t = new Date(
          Date.parse('2026-10-25T00:00:00Z') + h * HOUR + 59 * 60_000,
        );
        expect(localClock(t, tz)).toEqual({
          day: zonedWeekday(t, tz),
          hhmm: zonedHhmm(t, tz),
        });
      }
    }
  });

  const open = (o: string, c: string, closed = false) => ({
    open: o,
    close: c,
    closed,
  });
  const week = (d: ReturnType<typeof open>) =>
    Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((i) => [String(i), d]));

  it('opening hours: inside, outside, and the closing minute', () => {
    const w = week(open('10:00', '23:00'));
    const cairo = (hhmm: string) => new Date(`2026-11-06T${hhmm}:00+02:00`);
    expect(
      withinOpeningHours(w, 'Africa/Cairo', cairo('18:00'), cairo('19:00'), 15),
    ).toBe(true);
    expect(
      withinOpeningHours(w, 'Africa/Cairo', cairo('22:00'), cairo('23:00'), 1),
    ).toBe(true);
    expect(
      withinOpeningHours(w, 'Africa/Cairo', cairo('22:30'), cairo('23:30'), 15),
    ).toBe(false);
    expect(
      withinOpeningHours(w, 'Africa/Cairo', cairo('09:00'), cairo('10:30'), 15),
    ).toBe(false);
  });

  it('opening hours: overnight venue, closed day, missing hours, empty range', () => {
    const night = week(open('18:00', '02:00'));
    const cairo = (iso: string) => new Date(`${iso}+02:00`);
    expect(
      withinOpeningHours(
        night,
        'Africa/Cairo',
        cairo('2026-11-06T23:00:00'),
        cairo('2026-11-07T01:00:00'),
        15,
      ),
    ).toBe(true);
    expect(
      withinOpeningHours(
        night,
        'Africa/Cairo',
        cairo('2026-11-07T01:00:00'),
        cairo('2026-11-07T03:00:00'),
        15,
      ),
    ).toBe(false);
    expect(
      withinOpeningHours(
        week(open('00:00', '24:00', true)),
        'Africa/Cairo',
        cairo('2026-11-06T12:00:00'),
        cairo('2026-11-06T13:00:00'),
        15,
      ),
    ).toBe(false);
    expect(
      withinOpeningHours(
        null,
        'Africa/Cairo',
        cairo('2026-11-06T12:00:00'),
        cairo('2026-11-06T13:00:00'),
        15,
      ),
    ).toBe(false);
    expect(
      withinOpeningHours(
        week(open('00:00', '23:59')),
        'Africa/Cairo',
        cairo('2026-11-06T12:00:00'),
        cairo('2026-11-06T12:00:00'),
        15,
      ),
    ).toBe(false);
  });

  it('candidate starts cover the venue-local day, including a 23-hour DST day', () => {
    const normal = zonedDayBounds('2026-11-06', 'America/New_York');
    expect(candidateStarts(normal.start, normal.end, 60)).toHaveLength(24);
    const spring = zonedDayBounds('2026-03-08', 'America/New_York');
    expect(candidateStarts(spring.start, spring.end, 60)).toHaveLength(23);
    expect(candidateStarts(spring.start, spring.end, 0)).toEqual([]);
  });

  it('too far ahead is more than 90 days', () => {
    expect(tooFarAhead(new Date(NOW + 89 * 24 * HOUR), NOW)).toBe(false);
    expect(tooFarAhead(new Date(NOW + 91 * 24 * HOUR), NOW)).toBe(true);
  });
});

describe('busy spans and ranking', () => {
  const d = (h: number) => new Date(NOW + h * HOUR);
  const busy = [
    { courtId: 'a', from: d(2), to: d(3) },
    { courtId: 'b', from: d(5), to: null },
  ];

  it('touching ends do not overlap; real overlap does; an open span blocks everything after it', () => {
    expect(overlapsBusy(busy, 'a', d(1), d(2))).toBe(false);
    expect(overlapsBusy(busy, 'a', d(3), d(4))).toBe(false);
    expect(overlapsBusy(busy, 'a', d(2.5), d(3.5))).toBe(true);
    expect(overlapsBusy(busy, 'a', d(1), d(4))).toBe(true);
    expect(overlapsBusy(busy, 'b', d(9), d(10))).toBe(true);
    expect(overlapsBusy(busy, 'b', d(1), d(5))).toBe(false);
    expect(overlapsBusy(busy, 'c', d(2), d(3))).toBe(false);
  });

  it('nearest first, later wins a tie', () => {
    const items = [d(1), d(4), d(6), d(2)].map((startsAt) => ({ startsAt }));
    const sorted = nearestFirst(items, d(3), (x) => x.startsAt).map(
      (x) => (x.startsAt.getTime() - NOW) / HOUR,
    );
    expect(sorted).toEqual([4, 2, 1, 6]);
  });
});
