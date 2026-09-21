import { matchPricingRule, ruleActiveAt, type PricingRuleLike } from './pricing-rule.util';
import { quoteDurationPrice } from './price-quote.util';

const TZ = 'Africa/Cairo';
const base: PricingRuleLike & { label: string } = { label: 'base', daysOfWeek: [], startTime: '08:00', endTime: '23:00', priceAmount: 20000, currency: 'EGP', priority: 0 };
const discount = (over: Partial<PricingRuleLike> = {}): PricingRuleLike & { label: string } => ({
  label: 'discount-20%', daysOfWeek: [0], startTime: '14:00', endTime: '16:00', priceAmount: 16000, currency: 'EGP', priority: 10,
  kind: 'discount', validFrom: new Date('2026-09-21T00:00:00Z'), validUntil: new Date('2026-10-19T00:00:00Z'), ...over,
});
// Sunday 27 Sep 2026, 14:00 Cairo (+03) = 11:00 UTC
const sunday14 = new Date('2026-09-27T11:00:00Z');

describe('time-boxed pricing rules', () => {
  it('a discount applies to slots that start inside its window', () => {
    expect(matchPricingRule([base, discount()], 0, sunday14, TZ).priceAmount).toBe(16000);
  });

  it('only that weekday and those hours', () => {
    expect(matchPricingRule([base, discount()], 1, new Date('2026-09-28T11:00:00Z'), TZ).priceAmount).toBe(20000);
    expect(matchPricingRule([base, discount()], 0, new Date('2026-09-27T14:00:00Z'), TZ).priceAmount).toBe(20000);
  });

  it('expires by itself: a slot starting at or after validUntil is at the everyday price', () => {
    expect(matchPricingRule([base, discount()], 0, new Date('2026-10-25T11:00:00Z'), TZ).priceAmount).toBe(20000);
    expect(ruleActiveAt(discount(), new Date('2026-10-19T00:00:00Z'))).toBe(false);
    expect(ruleActiveAt(discount(), new Date('2026-10-18T23:59:59Z'))).toBe(true);
  });

  it('does not reach back before it started', () => {
    expect(matchPricingRule([base, discount()], 0, new Date('2026-09-20T11:00:00Z'), TZ).priceAmount).toBe(20000);
  });

  it('when nothing matches the fallback is an everyday rule, never a discount', () => {
    const rules = [discount({ startTime: '00:00', endTime: '01:00' }), base];
    expect(matchPricingRule(rules, 2, new Date('2026-09-30T23:30:00Z'), TZ).kind).not.toBe('discount');
  });

  it('a plain rule with no dates is unaffected', () => {
    expect(ruleActiveAt(base, new Date())).toBe(true);
  });

  it('a multi-hour quote crossing the window boundary prices each part correctly', () => {
    // 13:00–17:00 Cairo on Sunday: 13 base, 14–16 discounted, 16 base
    const quote = quoteDurationPrice([base, discount()], new Date('2026-09-27T10:00:00Z'), 240, TZ);
    expect(quote.priceAmount).toBe(20000 + 16000 * 2 + 20000);
  });

  it('a quote for a date after the discount ended uses the everyday price', () => {
    const quote = quoteDurationPrice([base, discount()], new Date('2026-10-25T11:00:00Z'), 120, TZ);
    expect(quote.priceAmount).toBe(40000);
  });
});
