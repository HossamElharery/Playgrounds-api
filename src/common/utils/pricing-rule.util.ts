import { zonedHhmm, zonedWeekday } from './timezone.util';

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

function candidateRules<T extends PricingRuleLike>(
  rules: T[],
  dayOfWeek: number,
  slotStart: Date,
  timeZone: string,
): T[] {
  const hhmm = zonedHhmm(slotStart, timeZone);
  return rules.filter(
    (r) =>
      ruleActiveAt(r, slotStart) &&
      (r.daysOfWeek.length === 0 || r.daysOfWeek.includes(dayOfWeek)) &&
      r.startTime <= hhmm &&
      hhmm < r.endTime,
  );
}

/**
 * The rule that really covers this slot, or `undefined` when the tariff has a hole there.
 * `matchPricingRule` papers over a hole with the first rule (so an old half-set-up court still
 * quotes something); the slot grid must not, or an uncovered hour shows up as bookable at the
 * wrong price — or at 0. A time-boxed discount alone never counts as coverage.
 */
/**
 * The winner among rules that all cover the slot: a time-boxed discount always beats an everyday
 * rule (that is what a discount is for), then the higher priority wins. Owners never see or set
 * "priority" — the venue page ranks everyday rules by how specific they are.
 */
export function bestRule<T extends PricingRuleLike>(candidates: T[]): T {
  const weight = (r: T) => (r.kind === 'discount' ? 1_000_000 : 0) + r.priority;
  return [...candidates].sort((a, b) => weight(b) - weight(a))[0];
}

export function coveringPricingRule<T extends PricingRuleLike>(
  rules: T[],
  dayOfWeek: number,
  slotStart: Date,
  timeZone: string,
): T | undefined {
  const candidates = candidateRules(rules, dayOfWeek, slotStart, timeZone);
  if (!candidates.some((r) => r.kind !== 'discount')) return undefined;
  return bestRule(candidates);
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
  const candidates = candidateRules(rules, dayOfWeek, slotStart, timeZone);
  // Nothing matches: fall back to an everyday rule, never to a (possibly expired) discount.
  if (!candidates.length) return rules.find((r) => r.kind !== 'discount') ?? rules[0];
  return bestRule(candidates);
}

/** Every part of a reservation must have an everyday tariff, including across midnight. */
export function hasPricingCoverage(rules: PricingRuleLike[], start: Date, end: Date, timeZone: string): boolean {
  for (let at = start.getTime(); at < end.getTime(); at += 15 * 60_000) {
    const instant = new Date(at);
    if (!coveringPricingRule(rules, zonedWeekday(instant, timeZone), instant, timeZone)) return false;
  }
  return end > start;
}
