import { zonedDayBounds, zonedWallTimeToUtc } from '../../../common/utils/timezone.util';
import { isTimeWithinDayHours, type WeeklyHours } from '../../../common/utils/weekly-hours.util';

const QUARTER_MS = 15 * 60_000;

/** Without opening hours on record a venue is assumed open 06:00–24:00, so empty nights do not drown the picture. */
const DEFAULT_DAY = { closed: false, open: '06:00', close: '23:59' } as const;

export interface GridInput {
  timeZone: string;
  /** Venue-local calendar dates (yyyy-mm-dd), any order. */
  dates: string[];
  weeklyHours: WeeklyHours | null;
  courtIds: string[];
  bookings: { courtId: string; slotStart: Date; slotEnd: Date }[];
  blocks: { courtId: string | null; startsAt: Date; endsAt: Date }[];
}

/** One venue-local hour on one date, in quarter-hours: how many were open, and how many were booked. */
export interface HourSample {
  date: string;
  open: number;
  occ: number;
}

/** `grid[courtId][weekday][hour]` → samples, most recent date first. */
export type OccupancyGrid = Record<string, HourSample[][][]>;

export interface DayTotal {
  date: string;
  weekday: number;
  openQuarters: number;
  occQuarters: number;
}

export interface GridResult {
  grid: OccupancyGrid;
  days: DayTotal[];
  /** Hours (venue-local) in which the venue is ever open, for drawing the map. */
  openHours: { from: number; to: number };
}

const hh = (n: number) => String(n).padStart(2, '0');

function markRange(arr: Uint8Array, base: number, from: Date, to: Date) {
  const first = Math.max(0, Math.floor((from.getTime() - base) / QUARTER_MS));
  const last = Math.min(arr.length, Math.ceil((to.getTime() - base) / QUARTER_MS));
  for (let i = first; i < last; i += 1) arr[i] = 1;
}

/**
 * Turns bookings, blocks and opening hours into per-court, per-weekday, per-hour samples.
 * Booked = any booking (Matchena or the venue's own) covering the quarter-hour; a quarter
 * that is closed or blocked does not count as open, so maintenance never reads as "empty".
 */
export function buildOccupancyGrid(input: GridInput): GridResult {
  const dates = [...new Set(input.dates)].sort();
  const grid: OccupancyGrid = {};
  const days: DayTotal[] = [];
  if (!dates.length) return { grid, days, openHours: { from: 6, to: 24 } };

  const first = zonedWallTimeToUtc(dates[0], '00:00', input.timeZone).getTime();
  const lastDayEnd = zonedWallTimeToUtc(dates[dates.length - 1], '23:59', input.timeZone).getTime() + 60_000;
  const quarters = Math.ceil((lastDayEnd - first) / QUARTER_MS) + 4;

  const booked: Record<string, Uint8Array> = {};
  const blocked: Record<string, Uint8Array> = {};
  for (const id of input.courtIds) {
    booked[id] = new Uint8Array(quarters);
    blocked[id] = new Uint8Array(quarters);
    grid[id] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => [] as HourSample[]));
  }
  for (const b of input.bookings) if (booked[b.courtId]) markRange(booked[b.courtId], first, b.slotStart, b.slotEnd);
  for (const b of input.blocks) {
    for (const id of b.courtId ? [b.courtId] : input.courtIds) {
      if (blocked[id]) markRange(blocked[id], first, b.startsAt, b.endsAt);
    }
  }

  let minOpen = 24;
  let maxOpen = 0;
  const newestFirst = [...dates].reverse();
  for (const date of newestFirst) {
    const weekday = zonedDayBounds(date, input.timeZone).dayOfWeek;
    const cfg = input.weeklyHours ? (input.weeklyHours[String(weekday)] ?? undefined) : DEFAULT_DAY;
    const total: DayTotal = { date, weekday, openQuarters: 0, occQuarters: 0 };
    for (let hour = 0; hour < 24; hour += 1) {
      const start = zonedWallTimeToUtc(date, `${hh(hour)}:00`, input.timeZone).getTime();
      const base = Math.round((start - first) / QUARTER_MS);
      const openQ: boolean[] = [];
      for (let q = 0; q < 4; q += 1) openQ.push(isTimeWithinDayHours(`${hh(hour)}:${hh(q * 15)}`, cfg as never));
      if (openQ.some(Boolean)) {
        minOpen = Math.min(minOpen, hour);
        maxOpen = Math.max(maxOpen, hour + 1);
      }
      for (const id of input.courtIds) {
        let open = 0;
        let occ = 0;
        for (let q = 0; q < 4; q += 1) {
          if (!openQ[q]) continue;
          const idx = base + q;
          if (idx < 0 || idx >= quarters || blocked[id][idx]) continue;
          open += 1;
          if (booked[id][idx]) occ += 1;
        }
        grid[id][weekday][hour].push({ date, open, occ });
        total.openQuarters += open;
        total.occQuarters += occ;
      }
    }
    days.push(total);
  }
  return { grid, days, openHours: minOpen > maxOpen ? { from: 6, to: 24 } : { from: minOpen, to: maxOpen } };
}

export function cellStats(samples: readonly HourSample[]): { open: number; occ: number; occupancy: number | null; days: number } {
  let open = 0;
  let occ = 0;
  let days = 0;
  for (const s of samples) {
    if (s.open > 0) days += 1;
    open += s.open;
    occ += s.occ;
  }
  return { open, occ, occupancy: open > 0 ? occ / open : null, days };
}

export const IDLE_BELOW = 0.3;
export const MIN_SAMPLE_WEEKS = 3;

/** An hour is idle when, among the last 4 times it was open on this weekday, at least 3 were under 30 % full. */
export function isIdleHour(samples: readonly HourSample[]): boolean {
  const recent = samples.filter((s) => s.open > 0).slice(0, 4);
  if (recent.length < MIN_SAMPLE_WEEKS) return false;
  return recent.filter((s) => s.occ / s.open < IDLE_BELOW).length >= MIN_SAMPLE_WEEKS;
}

export interface IdleWindow {
  weekday: number;
  startHour: number;
  /** Exclusive. */
  endHour: number;
  /** 0..1 over every sample of those hours. */
  occupancy: number;
  /** How many dates of that weekday the window has been measured on. */
  days: number;
}

/** Runs of at least two consecutive idle hours on one weekday of one court. */
export function findIdleWindows(courtGrid: HourSample[][][]): IdleWindow[] {
  const out: IdleWindow[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    let runStart = -1;
    const close = (endHour: number) => {
      if (runStart >= 0 && endHour - runStart >= 2) {
        const samples: HourSample[] = [];
        for (let h = runStart; h < endHour; h += 1) samples.push(...courtGrid[weekday][h]);
        const stats = cellStats(samples);
        const dates = new Set(samples.filter((s) => s.open > 0).map((s) => s.date));
        out.push({ weekday, startHour: runStart, endHour, occupancy: stats.occupancy ?? 0, days: dates.size });
      }
      runStart = -1;
    };
    for (let hour = 0; hour < 24; hour += 1) {
      if (isIdleHour(courtGrid[weekday][hour])) {
        if (runStart < 0) runStart = hour;
      } else {
        close(hour);
      }
    }
    close(24);
  }
  return out;
}

/** The discount worth trying at this occupancy (0..1); null when the window is busy enough already. */
export function suggestedPercent(occupancy: number): number | null {
  if (occupancy < 0.15) return 25;
  if (occupancy < 0.3) return 20;
  if (occupancy < 0.45) return 10;
  return null;
}

/**
 * Days that came in well below that weekday's usual. Needs 4+ dates of the weekday; the
 * newest date is compared with the average of the older ones.
 */
export function weekdayDips(days: readonly DayTotal[]): { weekday: number; date: string; belowPct: number }[] {
  const byWeekday = new Map<number, DayTotal[]>();
  for (const d of days) byWeekday.set(d.weekday, [...(byWeekday.get(d.weekday) ?? []), d]);
  const out: { weekday: number; date: string; belowPct: number }[] = [];
  for (const [weekday, list] of byWeekday) {
    const usable = list.filter((d) => d.openQuarters > 0); // newest first
    if (usable.length < 4) continue;
    const [latest, ...older] = usable;
    const avg = older.reduce((s, d) => s + d.occQuarters / d.openQuarters, 0) / older.length;
    const now = latest.occQuarters / latest.openQuarters;
    if (avg >= 0.25 && now < avg * 0.6) out.push({ weekday, date: latest.date, belowPct: Math.round((1 - now / avg) * 100) });
  }
  return out.sort((a, b) => b.belowPct - a.belowPct);
}
