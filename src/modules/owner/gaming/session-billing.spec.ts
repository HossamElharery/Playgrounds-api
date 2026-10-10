import { allocatePayment, calculateSessionCharge, SessionBillingPolicy } from './session-billing';
const exact: SessionBillingPolicy = { version: 1, mode: 'exact-time' };
const segment = (milliseconds: number, rate = 12000, startedAtMs = 0, currency = 'EGP') => ({ startedAtMs, endedAtMs: startedAtMs + milliseconds, hourlyRateMinor: rate, currency });
describe('gaming billing acceptance C03/C04 and D03', () => {
  it.each([[450000, 1500], [3570000, 11900], [3600000, 12000], [30000, 100], [1000, 3]])('exact elapsed %ims = %i minor', (ms, amount) => {
    expect(calculateSessionCharge([segment(ms)], exact).amountMinor).toBe(amount);
  });
  it('C03 rounds started minutes only when explicitly configured', () => {
    expect(calculateSessionCharge([segment(421000)], { version: 1, mode: 'ceil-started-minute' }).amountMinor).toBe(1600);
  });
  it('C04 preserves mixed rate transfers', () => {
    expect(calculateSessionCharge([segment(600000, 6000), segment(1200000, 12000, 600000)], exact).amountMinor).toBe(5000);
  });
  it('subminute transfers round once, independent of segment count', () => {
    const segments = Array.from({ length: 100 }, (_, i) => segment(100, 12000, i * 100));
    expect(calculateSessionCharge(segments, exact).amountMinor).toBe(33);
  });
  it('uses minor units independently of currency fraction digits', () => {
    expect(calculateSessionCharge([segment(450000, 120000, 0, 'KWD')], exact).amountMinor).toBe(15000);
  });
  it('minimum and step apply once across transfers', () => {
    expect(calculateSessionCharge([segment(1000, 6000), segment(1000, 12000, 1000)], { version: 1, mode: 'step-minutes', stepMinutes: 5, minimumMinutes: 10 }).amountMinor).toBe(1998);
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe rate %s', rate => {
    expect(() => calculateSessionCharge([segment(1, rate)], exact)).toThrow(RangeError);
  });
  it('rejects gaps, overlaps, mixed currency, negative time and overflow', () => {
    for (const segments of [[segment(10), segment(10, 1, 11)], [segment(10), segment(10, 1, 9)], [segment(10), segment(10, 1, 10, 'USD')], [segment(-1)], [segment(3600000, 2147483648)]]) {
      expect(() => calculateSessionCharge(segments, exact)).toThrow(RangeError);
    }
  });
  it('D03 deterministic partial payment preserves all minor units', () => {
    expect(allocatePayment(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(allocatePayment(5000, [5000, 3000, 2000])).toEqual([2500, 1500, 1000]);
    expect(() => allocatePayment(11, [10])).toThrow(RangeError);
  });
  it('allocation properties across 1000 deterministic fixtures', () => {
    for (let i = 0; i < 1000; i++) {
      const outstanding = [i % 19, (i * 7) % 97, (i * 3) % 71];
      const total = outstanding.reduce((n, v) => n + v, 0);
      const amount = Math.floor(total * .71);
      const allocation = allocatePayment(amount, outstanding);
      expect(allocation.reduce((n, v) => n + v, 0)).toBe(amount);
      expect(allocation.every((v, index) => v >= 0 && v <= outstanding[index])).toBe(true);
    }
  });
});
