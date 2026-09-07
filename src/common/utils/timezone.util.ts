const WEEKDAY_TO_JS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - instant.getTime();
}

/** Convert a civil wall-clock time in `timeZone` to a UTC Date. */
export function zonedWallTimeToUtc(
  dateStr: string,
  hhmm: string,
  timeZone: string,
): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = tzOffsetMs(new Date(utcGuess), timeZone);
  const adjusted = new Date(utcGuess - offset1);
  const offset2 = tzOffsetMs(adjusted, timeZone);
  return new Date(utcGuess - offset2);
}

function addCalendarDay(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

export function zonedDayBounds(
  dateStr: string,
  timeZone: string,
): { start: Date; end: Date; dayOfWeek: number } {
  const start = zonedWallTimeToUtc(dateStr, '00:00', timeZone);
  const end = zonedWallTimeToUtc(addCalendarDay(dateStr), '00:00', timeZone);
  const noon = zonedWallTimeToUtc(dateStr, '12:00', timeZone);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(noon);
  return { start, end, dayOfWeek: WEEKDAY_TO_JS[weekday] ?? noon.getUTCDay() };
}

export function zonedWeekday(instant: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(instant);
  return WEEKDAY_TO_JS[weekday] ?? instant.getUTCDay();
}

export function zonedHhmm(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
}
