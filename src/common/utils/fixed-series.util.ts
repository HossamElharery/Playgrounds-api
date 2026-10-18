import { zonedWallTimeToUtc } from './timezone.util';

export const FIXED_HORIZON_WEEKS = 8;
export const FIXED_MAX_WEEKS = 53;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: string): boolean {
  return DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

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
