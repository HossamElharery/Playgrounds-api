const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ALLOWED_MINUTES = new Set([0, 15, 30, 45]);

export interface WeeklyDayHours {
  closed: boolean;
  open?: string;
  close?: string;
}

export type WeeklyHours = Record<string, WeeklyDayHours>;

export function isValidHhmm(value?: string): boolean {
  if (!value || !HHMM.test(value)) return false;
  const minutes = Number(value.slice(3, 5));
  return ALLOWED_MINUTES.has(minutes);
}

/** Earlier closing time means overnight (next civil day). */
export function isOvernight(open: string, close: string): boolean {
  return close < open;
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function isTimeWithinDayHours(
  hhmm: string,
  day: WeeklyDayHours | undefined,
): boolean {
  if (!day || day.closed || !day.open || !day.close) return false;
  if (isOvernight(day.open, day.close)) {
    return hhmm >= day.open || hhmm < day.close;
  }
  return hhmm >= day.open && hhmm < day.close;
}

export function validateWeeklyHours(hours?: WeeklyHours | null): string[] {
  const errors: string[] = [];
  if (!hours || typeof hours !== 'object') {
    return ['Weekly hours are required'];
  }
  let openDays = 0;
  for (let i = 0; i <= 6; i += 1) {
    const day = hours[String(i)] ?? hours[i as unknown as string];
    if (!day) {
      errors.push(`Missing hours for weekday ${i}`);
      continue;
    }
    if (day.closed) continue;
    openDays += 1;
    if (!isValidHhmm(day.open) || !isValidHhmm(day.close)) {
      errors.push(`Weekday ${i} needs valid 15-minute opening and closing times`);
    } else if (day.open === day.close) {
      errors.push(`Weekday ${i} opening and closing times must differ`);
    }
  }
  if (openDays === 0) errors.push('At least one day must be open');
  return errors;
}
