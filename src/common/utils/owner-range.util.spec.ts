import { resolveOwnerRange } from './owner-range.util';
import { zonedDayBounds, zonedWallTimeToUtc } from './timezone.util';
import { ApiException } from '../errors/api-exception';

describe('owner range (Saturday-start weeks, venue TZ)', () => {
  const cairo = 'Africa/Cairo';

  it('this_week starts on Saturday in Africa/Cairo', () => {
    // Wednesday 16 Sep 2026 12:00 Cairo
    const now = zonedWallTimeToUtc('2026-09-16', '12:00', cairo);
    const range = resolveOwnerRange('this_week', cairo, undefined, undefined, now);
    expect(range.from).toBe('2026-09-12'); // Saturday
    expect(range.to).toBe('2026-09-18');
    expect(zonedDayBounds(range.from, cairo).dayOfWeek).toBe(6);
  });

  it('custom range over 366 days is RANGE_TOO_LARGE', () => {
    expect(() =>
      resolveOwnerRange('custom', cairo, '2025-01-01', '2026-12-31'),
    ).toThrow(ApiException);
  });

  it('a 23:30 local booking stays on that civil day; 23:30 UTC rolls in Cairo', () => {
    const local2330 = zonedWallTimeToUtc('2026-09-20', '23:30', cairo);
    const { start, end } = zonedDayBounds('2026-09-20', cairo);
    expect(local2330 >= start && local2330 < end).toBe(true);

    const utc2330 = new Date('2026-09-20T23:30:00.000Z');
    const cairoDay = zonedDayBounds('2026-09-21', cairo);
    expect(utc2330 >= cairoDay.start && utc2330 < cairoDay.end).toBe(true);
  });
});
