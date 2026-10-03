import { pricingGaps } from './pricing-coverage.util';
import { coveringPricingRule } from './pricing-rule.util';
import type { WeeklyHours } from './weekly-hours.util';

const TZ = 'Africa/Cairo';
const allDays = (open: string, close: string): WeeklyHours =>
  Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { closed: false, open, close }]));
const rule = (startTime: string, endTime: string, over: Record<string, unknown> = {}) => ({
  daysOfWeek: [] as number[],
  startTime,
  endTime,
  priceAmount: 20000,
  currency: 'EGP',
  priority: 0,
  kind: 'base',
  ...over,
});

describe('coveringPricingRule', () => {
  it('returns the rule that covers the hour', () => {
    // 20:00 Cairo (+03 in October is +03? Cairo DST ended — use a winter date to be unambiguous)
    const at = new Date('2026-12-05T18:00:00Z'); // 20:00 Cairo (UTC+2)
    expect(coveringPricingRule([rule('08:00', '23:00')], 6, at, TZ)?.priceAmount).toBe(20000);
  });

  it('returns nothing for an hour the tariff does not cover — never the first rule', () => {
    const at = new Date('2026-12-05T21:30:00Z'); // 23:30 Cairo
    expect(coveringPricingRule([rule('08:00', '23:00')], 6, at, TZ)).toBeUndefined();
  });

  it('returns nothing when there are no rules at all', () => {
    expect(coveringPricingRule([], 6, new Date('2026-12-05T18:00:00Z'), TZ)).toBeUndefined();
  });

  it('a discount alone does not make an uncovered hour priced', () => {
    const at = new Date('2026-12-05T21:30:00Z');
    expect(coveringPricingRule([rule('08:00', '23:00'), rule('23:00', '24:00', { kind: 'discount', priority: 10 })], 6, at, TZ)).toBeUndefined();
  });
});

describe('pricingGaps', () => {
  it('finds nothing when the tariff covers every open hour', () => {
    expect(pricingGaps([rule('08:00', '24:00')], allDays('08:00', '23:59'))).toEqual([]);
  });

  it('reports the hours after the last priced hour (open until 24:00, priced until 23:00)', () => {
    const gaps = pricingGaps([rule('08:00', '23:00')], allDays('08:00', '23:59'));
    expect(gaps).toHaveLength(7);
    expect(gaps[0]).toEqual({ day: 0, from: '23:00', to: '24:00' });
  });

  it('reports all open hours when the court has no rules', () => {
    const gaps = pricingGaps([], allDays('10:00', '12:00'));
    expect(gaps[0]).toEqual({ day: 0, from: '10:00', to: '12:00' });
  });

  it('respects weekday-specific rules and closed days', () => {
    const hours = allDays('08:00', '12:00');
    hours['5'] = { closed: true };
    const gaps = pricingGaps([rule('08:00', '12:00', { daysOfWeek: [0, 1, 2, 3, 4] })], hours);
    expect(gaps.map((g) => g.day)).toEqual([6]);
  });

  it('ignores discounts as coverage', () => {
    const gaps = pricingGaps([rule('08:00', '12:00', { kind: 'discount' })], allDays('08:00', '12:00'));
    expect(gaps).toHaveLength(7);
  });
});
