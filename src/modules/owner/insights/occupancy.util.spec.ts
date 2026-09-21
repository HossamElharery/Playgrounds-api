import {
  buildOccupancyGrid,
  cellStats,
  findIdleWindows,
  isIdleHour,
  suggestedPercent,
  weekdayDips,
  type HourSample,
} from './occupancy.util';

const TZ = 'Africa/Cairo';
const open = (o: string, c: string) => ({ closed: false, open: o, close: c });
const everyDay = (o: string, c: string) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), open(o, c)]));

/** Sundays in Sept 2026: 6, 13, 20, 27 (the 21st is a Monday). */
const SUNDAYS = ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27'];
const cairo = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+03:00`); // Egypt is +03 in summer 2026

describe('buildOccupancyGrid', () => {
  it('counts a booking in the venue-local hour it covers, on the right weekday, per court', () => {
    const { grid, days } = buildOccupancyGrid({
      timeZone: TZ, dates: ['2026-09-20'], weeklyHours: everyDay('08:00', '23:00'), courtIds: ['c1', 'c2'],
      bookings: [{ courtId: 'c1', slotStart: cairo('2026-09-20', '14:00'), slotEnd: cairo('2026-09-20', '16:00') }],
      blocks: [],
    });
    const sun = 0;
    expect(grid['c1'][sun][14][0]).toEqual({ date: '2026-09-20', open: 4, occ: 4 });
    expect(grid['c1'][sun][15][0]).toEqual({ date: '2026-09-20', open: 4, occ: 4 });
    expect(grid['c1'][sun][16][0]).toEqual({ date: '2026-09-20', open: 4, occ: 0 });
    expect(grid['c2'][sun][14][0].occ).toBe(0);
    expect(days[0].weekday).toBe(sun);
  });

  it('a booking that does not start on the hour is split across the hours it touches', () => {
    const { grid } = buildOccupancyGrid({
      timeZone: TZ, dates: ['2026-09-20'], weeklyHours: everyDay('08:00', '23:00'), courtIds: ['c1'],
      bookings: [{ courtId: 'c1', slotStart: cairo('2026-09-20', '15:30'), slotEnd: cairo('2026-09-20', '16:30') }],
      blocks: [],
    });
    expect(grid['c1'][0][15][0].occ).toBe(2);
    expect(grid['c1'][0][16][0].occ).toBe(2);
  });

  it('closed hours and blocked time are not "open", so maintenance never reads as empty', () => {
    const { grid } = buildOccupancyGrid({
      timeZone: TZ, dates: ['2026-09-20'], weeklyHours: everyDay('10:00', '20:00'), courtIds: ['c1'],
      bookings: [],
      blocks: [{ courtId: 'c1', startsAt: cairo('2026-09-20', '12:00'), endsAt: cairo('2026-09-20', '14:00') }],
    });
    expect(grid['c1'][0][8][0].open).toBe(0);
    expect(grid['c1'][0][12][0].open).toBe(0);
    expect(grid['c1'][0][13][0].open).toBe(0);
    expect(grid['c1'][0][14][0].open).toBe(4);
  });

  it('a venue-wide block (no court) blocks every court', () => {
    const { grid } = buildOccupancyGrid({
      timeZone: TZ, dates: ['2026-09-20'], weeklyHours: everyDay('10:00', '20:00'), courtIds: ['c1', 'c2'],
      bookings: [], blocks: [{ courtId: null, startsAt: cairo('2026-09-20', '12:00'), endsAt: cairo('2026-09-20', '13:00') }],
    });
    expect(grid['c1'][0][12][0].open).toBe(0);
    expect(grid['c2'][0][12][0].open).toBe(0);
  });

  it('reports the hours the venue is ever open, for drawing the map', () => {
    const { openHours } = buildOccupancyGrid({ timeZone: TZ, dates: ['2026-09-20'], weeklyHours: everyDay('09:00', '23:00'), courtIds: ['c1'], bookings: [], blocks: [] });
    expect(openHours).toEqual({ from: 9, to: 23 });
  });

  it('keeps samples newest first', () => {
    const { grid } = buildOccupancyGrid({ timeZone: TZ, dates: SUNDAYS, weeklyHours: everyDay('08:00', '23:00'), courtIds: ['c1'], bookings: [], blocks: [] });
    expect(grid['c1'][0][10].map((s) => s.date)).toEqual([...SUNDAYS].reverse());
  });
});

const sample = (occ: number, open = 4, date = 'd'): HourSample => ({ date, open, occ });

describe('idle detection', () => {
  it('an hour is idle when 3 of the last 4 were under 30 % full', () => {
    expect(isIdleHour([sample(0), sample(1), sample(4), sample(0)])).toBe(true);
    expect(isIdleHour([sample(4), sample(0), sample(4), sample(0)])).toBe(false);
  });

  it('needs at least 3 measured weeks — otherwise it is "collecting data"', () => {
    expect(isIdleHour([sample(0), sample(0)])).toBe(false);
    expect(isIdleHour([])).toBe(false);
  });

  it('closed hours do not count as samples', () => {
    expect(isIdleHour([sample(0, 0), sample(0), sample(0), sample(0)])).toBe(true);
    expect(isIdleHour([sample(0, 0), sample(0, 0), sample(0), sample(0)])).toBe(false);
  });

  it('finds Court 1 empty every Sunday 14:00–16:00 (the example from the brief)', () => {
    const bookings = SUNDAYS.flatMap((d) => [
      // busy evenings, every Sunday
      { courtId: 'c1', slotStart: cairo(d, '18:00'), slotEnd: cairo(d, '22:00') },
      { courtId: 'c1', slotStart: cairo(d, '10:00'), slotEnd: cairo(d, '14:00') },
    ]);
    const { grid } = buildOccupancyGrid({ timeZone: TZ, dates: SUNDAYS, weeklyHours: everyDay('10:00', '22:00'), courtIds: ['c1'], bookings, blocks: [] });
    const windows = findIdleWindows(grid['c1']).filter((w) => w.weekday === 0);
    expect(windows).toEqual([{ weekday: 0, startHour: 14, endHour: 18, occupancy: 0, days: 4 }]);
  });

  it('a single idle hour is not a window', () => {
    const bookings = SUNDAYS.flatMap((d) => [
      { courtId: 'c1', slotStart: cairo(d, '10:00'), slotEnd: cairo(d, '14:00') },
      { courtId: 'c1', slotStart: cairo(d, '15:00'), slotEnd: cairo(d, '22:00') },
    ]);
    const { grid } = buildOccupancyGrid({ timeZone: TZ, dates: SUNDAYS, weeklyHours: everyDay('10:00', '22:00'), courtIds: ['c1'], bookings, blocks: [] });
    expect(findIdleWindows(grid['c1'])).toEqual([]);
  });

  it('cellStats sums quarters', () => {
    expect(cellStats([sample(2), sample(4)])).toEqual({ open: 8, occ: 6, occupancy: 0.75, days: 2 });
    expect(cellStats([])).toEqual({ open: 0, occ: 0, occupancy: null, days: 0 });
  });
});

describe('suggestedPercent', () => {
  it('goes deeper the emptier the window is, and stays silent when it is busy', () => {
    expect(suggestedPercent(0.05)).toBe(25);
    expect(suggestedPercent(0.2)).toBe(20);
    expect(suggestedPercent(0.4)).toBe(10);
    expect(suggestedPercent(0.6)).toBeNull();
  });
});

describe('weekdayDips', () => {
  const d = (date: string, occ: number, weekday = 3): { date: string; weekday: number; openQuarters: number; occQuarters: number } => ({ date, weekday, openQuarters: 100, occQuarters: occ });

  it('flags a weekday that came in far below its usual', () => {
    const dips = weekdayDips([d('2026-09-16', 20), d('2026-09-09', 60), d('2026-09-02', 55), d('2026-08-26', 65)]);
    expect(dips).toEqual([{ weekday: 3, date: '2026-09-16', belowPct: 67 }]);
  });

  it('needs four weeks, and ignores weekdays that are always quiet', () => {
    expect(weekdayDips([d('a', 10), d('b', 60), d('c', 60)])).toEqual([]);
    expect(weekdayDips([d('a', 5), d('b', 20), d('c', 20), d('d', 20)])).toEqual([]);
  });

  it('a normal week is not a dip', () => {
    expect(weekdayDips([d('a', 55), d('b', 60), d('c', 58), d('d', 62)])).toEqual([]);
  });
});
