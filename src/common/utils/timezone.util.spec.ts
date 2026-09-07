import { zonedDayBounds, zonedWallTimeToUtc } from './timezone.util';

describe('timezone.util', () => {
  it('places Cairo midnight ahead of UTC (positive offset)', () => {
    const cairo = zonedWallTimeToUtc('2026-01-15', '00:00', 'Africa/Cairo');
    const utc = new Date('2026-01-15T00:00:00.000Z');
    expect(cairo.getTime()).toBeLessThan(utc.getTime());
  });

  it('keeps Dubai and Cairo civil midnights as different instants', () => {
    const cairo = zonedWallTimeToUtc('2026-06-01', '00:00', 'Africa/Cairo');
    const dubai = zonedWallTimeToUtc('2026-06-01', '00:00', 'Asia/Dubai');
    expect(cairo.getTime()).not.toBe(dubai.getTime());
  });

  it('returns a 24h window whose weekday matches the civil date', () => {
    // 2026-09-04 is a Friday
    const { start, end, dayOfWeek } = zonedDayBounds(
      '2026-09-04',
      'Asia/Riyadh',
    );
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(dayOfWeek).toBe(5);
  });
});
