import { zonedHhmm } from './timezone.util';
import { bestRule, ruleActiveAt, type PricingRuleLike } from './pricing-rule.util';
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
  minutePrecision = false,
): { priceAmount: number | null; currency: string; breakdown: PriceQuoteSegment[] } {
  if (!rules.length || durationMinutes <= 0) {
    return { priceAmount: null, currency: 'EGP', breakdown: [] };
  }
  const step = minutePrecision ? 1 : 15;
  let weightedMinorMs = 0n;
  const breakdown: PriceQuoteSegment[] = [];
  let total = 0;
  let currency = rules[0].currency ?? 'EGP';
  let elapsedMs = 0;
  while (elapsedMs < durationMinutes * 60_000) {
    const segStart = new Date(startsAt.getTime() + elapsedMs);
    const segEnd = new Date(
      minutePrecision
        ? Math.min(startsAt.getTime() + durationMinutes * 60_000, (Math.floor(segStart.getTime() / 60_000) + 1) * 60_000)
        : startsAt.getTime() + Math.min(elapsedMs + step * 60_000, durationMinutes * 60_000),
    );
    const hhmm = zonedHhmm(segStart, timeZone);
    const day = zonedWeekday(segStart, timeZone);
    const candidates = rules.filter(
      (r) =>
        ruleActiveAt(r, segStart) &&
        (r.daysOfWeek.length === 0 || r.daysOfWeek.includes(day)) &&
        r.startTime <= hhmm &&
        hhmm < r.endTime,
    );
    if (!candidates.some(r => r.kind !== 'discount')) {
      return { priceAmount: null, currency, breakdown: [] };
    }
    const rule = bestRule(candidates);
    const minutes = (segEnd.getTime() - segStart.getTime()) / 60_000;
    let amount = Math.round((rule.priceAmount * minutes) / 60);
    if (minutePrecision) {
      weightedMinorMs += BigInt(rule.priceAmount) * BigInt(segEnd.getTime() - segStart.getTime());
      const roundedTotal = Number((weightedMinorMs + 1_800_000n) / 3_600_000n);
      amount = roundedTotal - total;
    }
    total += amount;
    currency = rule.currency ?? currency;
    elapsedMs = segEnd.getTime() - startsAt.getTime();
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
