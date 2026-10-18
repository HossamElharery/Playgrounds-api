import { zonedHhmm, zonedWeekday } from './timezone.util';

export interface PricingRuleLike {
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  priceAmount: number;
  currency: string;
  priority: number;
  kind?: string | null;
  validFrom?: Date | null;
  validUntil?: Date | null;
}

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

export function matchPricingRule<T extends PricingRuleLike>(
  rules: T[],
  dayOfWeek: number,
  slotStart: Date,
  timeZone: string,
): T {
  const candidates = candidateRules(rules, dayOfWeek, slotStart, timeZone);
  if (!candidates.length) return rules.find((r) => r.kind !== 'discount') ?? rules[0];
  return bestRule(candidates);
}

export function hasPricingCoverage(rules: PricingRuleLike[], start: Date, end: Date, timeZone: string): boolean {
  for (let at = start.getTime(); at < end.getTime(); at += 15 * 60_000) {
    const instant = new Date(at);
    if (!coveringPricingRule(rules, zonedWeekday(instant, timeZone), instant, timeZone)) return false;
  }
  return end > start;
}
