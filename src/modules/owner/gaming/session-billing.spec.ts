import type { UsageSegment, UsageSession } from '@prisma/client';
import {
  allocatePayment,
  calculateSessionCharge,
  calculateUsageCharge,
  capsAtPlannedEnd,
  SessionBillingPolicy,
} from './session-billing';
const exact: SessionBillingPolicy = { version: 1, mode: 'exact-time' };
const segment = (
  milliseconds: number,
  rate = 12000,
  startedAtMs = 0,
  currency = 'EGP',
) => ({
  startedAtMs,
  endedAtMs: startedAtMs + milliseconds,
  hourlyRateMinor: rate,
  currency,
});
describe('gaming billing acceptance C03/C04 and D03', () => {
  it.each([
    [450000, 1500],
    [3570000, 11900],
    [3600000, 12000],
    [30000, 100],
    [1000, 3],
  ])('exact elapsed %ims = %i minor', (ms, amount) => {
    expect(calculateSessionCharge([segment(ms)], exact).amountMinor).toBe(
      amount,
    );
  });
  it('C03 rounds started minutes only when explicitly configured', () => {
    expect(
      calculateSessionCharge([segment(421000)], {
        version: 1,
        mode: 'ceil-started-minute',
      }).amountMinor,
    ).toBe(1600);
  });
  it('C04 preserves mixed rate transfers', () => {
    expect(
      calculateSessionCharge(
        [segment(600000, 6000), segment(1200000, 12000, 600000)],
        exact,
      ).amountMinor,
    ).toBe(5000);
  });
  it('subminute transfers round once, independent of segment count', () => {
    const segments = Array.from({ length: 100 }, (_, i) =>
      segment(100, 12000, i * 100),
    );
    expect(calculateSessionCharge(segments, exact).amountMinor).toBe(33);
  });
  it('uses minor units independently of currency fraction digits', () => {
    expect(
      calculateSessionCharge([segment(450000, 120000, 0, 'KWD')], exact)
        .amountMinor,
    ).toBe(15000);
  });
  it('minimum and step apply once across transfers', () => {
    expect(
      calculateSessionCharge(
        [segment(1000, 6000), segment(1000, 12000, 1000)],
        {
          version: 1,
          mode: 'step-minutes',
          stepMinutes: 5,
          minimumMinutes: 10,
        },
      ).amountMinor,
    ).toBe(1998);
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe rate %s',
    (rate) => {
      expect(() => calculateSessionCharge([segment(1, rate)], exact)).toThrow(
        RangeError,
      );
    },
  );
  it('rejects gaps, overlaps, mixed currency, negative time and overflow', () => {
    for (const segments of [
      [segment(10), segment(10, 1, 11)],
      [segment(10), segment(10, 1, 9)],
      [segment(10), segment(10, 1, 10, 'USD')],
      [segment(-1)],
      [segment(3600000, 2147483648)],
    ]) {
      expect(() => calculateSessionCharge(segments, exact)).toThrow(RangeError);
    }
  });
  it('D03 deterministic partial payment preserves all minor units', () => {
    expect(allocatePayment(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(allocatePayment(5000, [5000, 3000, 2000])).toEqual([
      2500, 1500, 1000,
    ]);
    expect(() => allocatePayment(11, [10])).toThrow(RangeError);
  });
  it('allocation properties across 1000 deterministic fixtures', () => {
    for (let i = 0; i < 1000; i++) {
      const outstanding = [i % 19, (i * 7) % 97, (i * 3) % 71];
      const total = outstanding.reduce((n, v) => n + v, 0);
      const amount = Math.floor(total * 0.71);
      const allocation = allocatePayment(amount, outstanding);
      expect(allocation.reduce((n, v) => n + v, 0)).toBe(amount);
      expect(
        allocation.every((v, index) => v >= 0 && v <= outstanding[index]),
      ).toBe(true);
    }
  });
});

describe('what a timed session is billed after its planned end', () => {
  const MIN = 60_000;
  const t0 = Date.parse('2026-11-06T10:00:00Z');
  const seg = (fromMin: number, toMin: number | null, rate = 12000) =>
    ({
      startedAt: new Date(t0 + fromMin * MIN),
      endedAt: toMin === null ? null : new Date(t0 + toMin * MIN),
      hourlyRateMinor: rate,
      currency: 'EGP',
      rateSnapshot: {},
    }) as unknown as UsageSegment;
  const session = (
    policy: Partial<SessionBillingPolicy>,
    endMin: number | null,
    segments: UsageSegment[],
    bookingId: string | null = null,
  ) =>
    ({
      state: 'running',
      bookingId,
      expectedEnd: endMin === null ? null : new Date(t0 + endMin * MIN),
      endedAt: null,
      policy: { ...exact, ...policy },
      segments,
    }) as unknown as UsageSession & { segments: UsageSegment[] };
  const at = (min: number) => new Date(t0 + min * MIN);

  it('continue (and sessions saved before this option existed) keep counting', () => {
    expect(
      calculateUsageCharge(
        session({ overrun: 'continue' }, 2, [seg(0, null)]),
        at(5),
      ),
    ).toBe(1000);
    expect(calculateUsageCharge(session({}, 2, [seg(0, null)]), at(5))).toBe(
      1000,
    );
  });
  it('stop: the bill freezes at the planned end, whether the session is still open or ended later', () => {
    const open = session({ overrun: 'stop' }, 2, [seg(0, null)]);
    expect(calculateUsageCharge(open, at(1))).toBe(200);
    expect(calculateUsageCharge(open, at(2))).toBe(400);
    expect(calculateUsageCharge(open, at(9))).toBe(400);
    const ended = session({ overrun: 'stop' }, 2, [seg(0, 6)]);
    expect(calculateUsageCharge(ended, at(30))).toBe(400);
  });
  it('stop: waiting for an extension is not billed (paused time), and the new end caps again', () => {
    // planned 2 min, extended at minute 5 by 15 min -> new end minute 20, 3 minutes were waiting
    const extended = session({ overrun: 'stop', pausedMs: 3 * MIN }, 20, [
      seg(0, null),
    ]);
    expect(calculateUsageCharge(extended, at(5))).toBe(400); // still just the 2 minutes
    expect(calculateUsageCharge(extended, at(10))).toBe(1400); // 2 + 5 minutes of the extension
    expect(calculateUsageCharge(extended, at(40))).toBe(3400); // capped: 2 + 15
  });
  it('stop keeps mixed rates and minimum minutes working', () => {
    const moved = session({ overrun: 'stop' }, 30, [
      seg(0, 10, 6000),
      seg(10, null, 12000),
    ]);
    expect(calculateUsageCharge(moved, at(40))).toBe(1000 + 4000);
    const withMinimum = session({ overrun: 'stop', minimumMinutes: 10 }, 2, [
      seg(0, null),
    ]);
    expect(calculateUsageCharge(withMinimum, at(9))).toBe(2000);
  });
  it('booking sessions and open sessions are never capped', () => {
    expect(
      capsAtPlannedEnd(
        session({ overrun: 'stop' }, 2, [seg(0, null)], 'booking-1'),
      ),
    ).toBe(false);
    expect(
      capsAtPlannedEnd(session({ overrun: 'stop' }, null, [seg(0, null)])),
    ).toBe(false);
    expect(
      capsAtPlannedEnd(session({ overrun: 'auto-end' }, 2, [seg(0, null)])),
    ).toBe(true);
    expect(
      calculateUsageCharge(
        session({ overrun: 'stop' }, null, [seg(0, null)]),
        at(5),
      ),
    ).toBe(1000);
  });
});
