import { quoteDurationPrice } from './price-quote.util';

const rule = (priceAmount: number, extra: Partial<{ startTime: string; endTime: string; priority: number; label: string }> = {}) => ({
  daysOfWeek: [] as number[],
  startTime: extra.startTime ?? '00:00',
  endTime: extra.endTime ?? '24:00',
  priceAmount,
  currency: 'KWD',
  priority: extra.priority ?? 0,
  label: extra.label ?? 'base',
});

// 2026-11-04 is a Wednesday; Africa/Cairo is UTC+2 in November.
const at = (hhmm: string) => new Date(`2026-11-04T${hhmm}:00+02:00`);

describe('quoteDurationPrice', () => {
  it('charges exactly the hourly rate for a full hour, whatever the amount', () => {
    for (const price of [125, 175, 1250, 9950, 12000, 3333, 1]) {
      expect(quoteDurationPrice([rule(price)], at('10:00'), 60, 'Africa/Cairo').priceAmount).toBe(price);
    }
  });

  it('does not drift by a rounding step per quarter hour (1.25 must stay 1.25, not 1.24)', () => {
    expect(quoteDurationPrice([rule(125)], at('10:00'), 60, 'Africa/Cairo').priceAmount).toBe(125);
    expect(quoteDurationPrice([rule(1250)], at('10:00'), 60, 'Africa/Cairo').priceAmount).toBe(1250);
  });

  it('prices two hours as exactly twice the hour', () => {
    expect(quoteDurationPrice([rule(125)], at('10:00'), 120, 'Africa/Cairo').priceAmount).toBe(250);
    expect(quoteDurationPrice([rule(9950)], at('10:00'), 90, 'Africa/Cairo').priceAmount).toBe(14925);
  });

  it('follows a price change inside the booking without losing a unit', () => {
    const rules = [rule(125, { endTime: '17:00' }), rule(175, { startTime: '17:00', priority: 1, label: 'peak' })];
    expect(quoteDurationPrice(rules, at('16:00'), 60, 'Africa/Cairo').priceAmount).toBe(125);
    expect(quoteDurationPrice(rules, at('17:00'), 60, 'Africa/Cairo').priceAmount).toBe(175);
    // 16:30 -> 17:30 is half an hour at 1.25 and half an hour at 1.75
    expect(quoteDurationPrice(rules, at('16:30'), 60, 'Africa/Cairo').priceAmount).toBe(150);
  });

  it('returns null when no rule covers the time', () => {
    expect(quoteDurationPrice([rule(125, { startTime: '18:00' })], at('10:00'), 60, 'Africa/Cairo').priceAmount).toBeNull();
  });
});
