import { isTimeWithinDayHours, type WeeklyHours } from './weekly-hours.util';
import type { PricingRuleLike } from './pricing-rule.util';

export interface PricingGap {
  day: number;
  from: string;
  to: string;
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function pricingGaps(
  rules: Array<Pick<PricingRuleLike, 'daysOfWeek' | 'startTime' | 'endTime' | 'kind'>>,
  weeklyHours: WeeklyHours | null | undefined,
  stepMinutes = 15,
): PricingGap[] {
  if (!weeklyHours) return [];
  const base = rules.filter((r) => r.kind !== 'discount');
  const gaps: PricingGap[] = [];
  for (let day = 0; day <= 6; day += 1) {
    const hours = weeklyHours[String(day)] ?? weeklyHours[day as unknown as string];
    if (!hours || hours.closed) continue;
    let open: number | null = null;
    for (let at = 0; at <= 24 * 60; at += stepMinutes) {
      const clock = at === 24 * 60 ? '24:00' : hhmm(at);
      const isOpen = at < 24 * 60 && isTimeWithinDayHours(clock, hours);
      const covered =
        !isOpen ||
        base.some(
          (r) =>
            (r.daysOfWeek.length === 0 || r.daysOfWeek.includes(day)) &&
            r.startTime <= clock &&
            clock < r.endTime,
        );
      if (!covered && open === null) open = at;
      if (covered && open !== null) {
        gaps.push({ day, from: hhmm(open), to: at === 24 * 60 ? '24:00' : hhmm(at) });
        open = null;
      }
    }
  }
  return gaps;
}

export function hasPricedHours(
  rules: Array<Pick<PricingRuleLike, 'daysOfWeek' | 'startTime' | 'endTime' | 'kind'>>,
  weeklyHours: WeeklyHours | null | undefined,
  stepMinutes = 15,
): boolean {
  if (!weeklyHours) return false;
  const base = rules.filter((r) => r.kind !== 'discount');
  for (let day = 0; day <= 6; day += 1) {
    const hours = weeklyHours[String(day)] ?? weeklyHours[day as unknown as string];
    if (!hours || hours.closed) continue;
    for (let at = 0; at < 24 * 60; at += stepMinutes) {
      const clock = hhmm(at);
      if (!isTimeWithinDayHours(clock, hours)) continue;
      if (
        base.some(
          (r) =>
            (r.daysOfWeek.length === 0 || r.daysOfWeek.includes(day)) &&
            r.startTime <= clock &&
            clock < r.endTime,
        )
      )
        return true;
    }
  }
  return false;
}
