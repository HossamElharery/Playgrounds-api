import { zonedHhmm } from './timezone.util';

export interface PricingRuleLike {
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  priceAmount: number;
  currency: string;
  priority: number;
}

/**
 * Picks the highest-priority pricing rule that covers a given slot start,
 * falling back to the first rule if nothing matches. Shared by
 * BookingsService (slot-grid pricing) and BundlesService (bundle item
 * pricing) so both price a court identically.
 */
export function matchPricingRule<T extends PricingRuleLike>(
  rules: T[],
  dayOfWeek: number,
  slotStart: Date,
  timeZone: string,
): T {
  const hhmm = zonedHhmm(slotStart, timeZone);
  const candidates = rules.filter(
    (r) =>
      (r.daysOfWeek.length === 0 || r.daysOfWeek.includes(dayOfWeek)) &&
      r.startTime <= hhmm &&
      hhmm < r.endTime,
  );
  if (!candidates.length) return rules[0];
  return candidates.sort((a, b) => b.priority - a.priority)[0];
}
