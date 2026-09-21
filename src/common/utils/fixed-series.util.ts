import { zonedWallTimeToUtc } from './timezone.util';

/** How far ahead sessions are actually booked; the daily job keeps this window full. */
export const FIXED_HORIZON_WEEKS = 8;
/** A series can run for at most a year, so a typo in "until" cannot book thousands of rows. */
export const FIXED_MAX_WEEKS = 53;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: string): boolean {
  return DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Calendar arithmetic on a `YYYY-MM-DD` string (no timezone involved, so DST-proof). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The venue-local calendar date of an instant. */
export function zonedDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function weekdayOfLocalDate(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/**
 * Local dates of a weekly series: startDate, +7, +14 … Every date is a wall-clock
 * date, so "same hour next week" holds across a daylight-saving change.
 */
export function seriesDates(
  startDate: string,
  opts: { until?: string | null; toDate?: string; maxCount?: number },
): string[] {
  const out: string[] = [];
  const max = opts.maxCount ?? FIXED_MAX_WEEKS;
  for (let i = 0; i < max; i++) {
    const date = addDays(startDate, i * 7);
    if (opts.until && date > opts.until) break;
    if (opts.toDate && date > opts.toDate) break;
    out.push(date);
  }
  return out;
}

export function sessionWindow(
  date: string,
  startTime: string,
  durationMins: number,
  timeZone: string,
): { start: Date; end: Date } {
  const start = zonedWallTimeToUtc(date, startTime, timeZone);
  return { start, end: new Date(start.getTime() + durationMins * 60_000) };
}
