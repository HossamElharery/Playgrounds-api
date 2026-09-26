/** Venue dates and slot times are Cairo civil time. */
export const KIOSK_TZ = 'Africa/Cairo';

/** How long a proposal stays open. */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;

/** A proposal date may be today through this many days ahead (inclusive). */
export const PROPOSAL_DAY_SPAN = 13;

export function cairoYmd(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: KIOSK_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Calendar-day arithmetic on a `YYYY-MM-DD` string (no time zone). */
export function addCalendarDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` + `HH:mm` in Africa/Cairo, as a UTC epoch ms.
 * Returns null when the strings are not a real clock time.
 */
export function cairoLocalToUtcMs(ymd: string, hhmm: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const [y, mo, d] = ymd.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: KIOSK_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utc));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  let hour = n('hour');
  let day = n('day');
  let month = n('month');
  let year = n('year');
  // Some engines format midnight as hour 24.
  if (hour === 24) {
    hour = 0;
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  const asUtc = Date.UTC(year, month - 1, day, hour, n('minute'), n('second'));
  return utc - (asUtc - utc);
}
