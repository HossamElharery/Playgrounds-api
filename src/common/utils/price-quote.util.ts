import { zonedHhmm } from './timezone.util';
import type { PricingRuleLike } from './pricing-rule.util';
import { zonedWeekday } from './timezone.util';

export interface PriceQuoteSegment {
  from: string;
  to: string;
  label: string;
  amount: number;
}

export function quoteDurationPrice(
  rules: Array<PricingRuleLike & { label?: string }>,
  startsAt: Date,
  durationMinutes: number,
  timeZone: string,
): { priceAmount: number | null; currency: string; breakdown: PriceQuoteSegment[] } {
  if (!rules.length || durationMinutes <= 0) {
    return { priceAmount: null, currency: 'EGP', breakdown: [] };
  }
  const step = 15;
  const breakdown: PriceQuoteSegment[] = [];
  let total = 0;
  let currency = rules[0].currency ?? 'EGP';
  for (let elapsed = 0; elapsed < durationMinutes; elapsed += step) {
    const segStart = new Date(startsAt.getTime() + elapsed * 60_000);
    const segEnd = new Date(
      startsAt.getTime() + Math.min(elapsed + step, durationMinutes) * 60_000,
    );
    const hhmm = zonedHhmm(segStart, timeZone);
    const day = zonedWeekday(segStart, timeZone);
    const candidates = rules.filter(
      (r) =>
        (r.daysOfWeek.length === 0 || r.daysOfWeek.includes(day)) &&
        r.startTime <= hhmm &&
        hhmm < r.endTime,
    );
    if (!candidates.length) {
      return { priceAmount: null, currency, breakdown: [] };
    }
    const rule = candidates.sort((a, b) => b.priority - a.priority)[0];
    const minutes = (segEnd.getTime() - segStart.getTime()) / 60_000;
    const amount = Math.round((rule.priceAmount * minutes) / 60);
    total += amount;
    currency = rule.currency ?? currency;
    const last = breakdown[breakdown.length - 1];
    if (last && last.label === (rule.label ?? 'base') && last.amount / ((new Date(last.to).getTime() - new Date(last.from).getTime()) / 60_000) === amount / minutes) {
      last.to = segEnd.toISOString();
      last.amount += amount;
    } else {
      breakdown.push({
        from: segStart.toISOString(),
        to: segEnd.toISOString(),
        label: rule.label ?? 'base',
        amount,
      });
    }
  }
  return { priceAmount: total, currency, breakdown };
}
