import { isTimeWithinDayHours, validateWeeklyHours } from './weekly-hours.util';

describe('weekly hours', () => {
  it('requires at least one open day and 15-minute steps', () => {
    expect(
      validateWeeklyHours({
        '0': { closed: true },
        '1': { closed: false, open: '08:00', close: '23:00' },
        '2': { closed: true },
        '3': { closed: true },
        '4': { closed: true },
        '5': { closed: true },
        '6': { closed: true },
      }),
    ).toEqual([]);
    expect(
      validateWeeklyHours({
        '0': { closed: true },
        '1': { closed: false, open: '08:10', close: '23:00' },
        '2': { closed: true },
        '3': { closed: true },
        '4': { closed: true },
        '5': { closed: true },
        '6': { closed: true },
      }).length,
    ).toBeGreaterThan(0);
  });

  it('accepts midnight only as an exclusive closing time and keeps the last quarter', () => {
    const week = Object.fromEntries([0,1,2,3,4,5,6].map(d => [d, {closed:false,open:'00:00',close:'24:00'}]));
    expect(validateWeeklyHours(week)).toEqual([]);
    expect(isTimeWithinDayHours('23:45', week['0'])).toBe(true);
    expect(validateWeeklyHours({...week, '0': {closed:false,open:'24:00',close:'01:00'}}).length).toBeGreaterThan(0);
  });

  it('treats earlier closing as overnight', () => {
    expect(
      isTimeWithinDayHours('23:00', { closed: false, open: '18:00', close: '02:00' }),
    ).toBe(true);
    expect(
      isTimeWithinDayHours('01:00', { closed: false, open: '18:00', close: '02:00' }),
    ).toBe(true);
    expect(
      isTimeWithinDayHours('12:00', { closed: false, open: '18:00', close: '02:00' }),
    ).toBe(false);
  });
});
