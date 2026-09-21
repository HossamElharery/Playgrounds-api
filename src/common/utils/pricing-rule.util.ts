import { zonedHhmm } from './timezone.util';

export interface PricingRuleLike {
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  priceAmount: number;
  currency: string;
  priority: number;
  /** `discount` rules are time-boxed and must never be the fallback price. Undefined = base. */
  kind?: string | null;
  /** The rule only applies to slots that START inside [validFrom, validUntil). */
  validFrom?: Date | null;
  validUntil?: Date | null;
}

/** Is this rule in force for a slot starting at `instant`? Everyday rules (no dates) always are. */
export function ruleActiveAt(rule: PricingRuleLike, instant: Date): boolean {
  if (rule.validFrom && instant < rule.validFrom) return false;
  if (rule.validUntil && instant >= rule.validUntil) return false;
  return true;
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
      ruleActiveAt(r, slotStart) &&
      (r.daysOfWeek.length === 0 || r.daysOfWeek.includes(dayOfWeek)) &&
      r.startTime <= hhmm &&
      hhmm < r.endTime,
  );
  // Nothing matches: fall back to an everyday rule, never to a (possibly expired) discount.
  if (!candidates.length) return rules.find((r) => r.kind !== 'discount') ?? rules[0];
  return candidates.sort((a, b) => b.priority - a.priority)[0];
}
