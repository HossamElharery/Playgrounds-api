/** The AI day is a UTC day, the same boundary the in-memory counters always used. */
export function utcDayString(now: number | Date = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** A `@db.Date` value for a `YYYY-MM-DD` day. */
export function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, delta: number): string {
  const d = dayDate(day);
  d.setUTCDate(d.getUTCDate() + delta);
  return utcDayString(d);
}

export const USD_TO_MICROS = 1_000_000;

export function toMicros(usd: number): number {
  return Number.isFinite(usd) && usd > 0 ? Math.round(usd * USD_TO_MICROS) : 0;
}

export function fromMicros(micros: number): number {
  return Math.round(micros) / USD_TO_MICROS;
}
