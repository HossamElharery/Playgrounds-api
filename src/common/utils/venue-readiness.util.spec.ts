import { bookingBlockers, hasOpeningHours, venuePricingGaps } from './venue-readiness.util';

const open = { '0': { closed: false, open: '09:00', close: '23:00' } };
const placed = { lat: 30.05, lng: 31.2, address: '12 Nile St' };

describe('bookingBlockers', () => {
  it('is empty for a venue with hours, a court priced, and a place on the map', () => {
    expect(bookingBlockers({ weeklyHours: open, ...placed }, [{ pricingRules: 2 }])).toEqual([]);
  });

  it('treats missing hours as not bookable instead of open 24 hours', () => {
    expect(bookingBlockers({ weeklyHours: null, ...placed }, [{ pricingRules: 1 }])).toEqual(['hours']);
    expect(hasOpeningHours({ '0': { closed: true } })).toBe(false);
  });

  it('lists every missing piece, once', () => {
    expect(bookingBlockers({ weeklyHours: null, lat: 0, lng: 0, address: '' }, [])).toEqual(['hours', 'courts', 'location']);
  });

  it('asks for a price when any court has none', () => {
    expect(bookingBlockers({ weeklyHours: open, ...placed }, [{ pricingRules: 1 }, { pricingRules: 0 }])).toEqual(['prices']);
  });
});

describe('bookingBlockers with the price list', () => {
  const hours = { '0': { closed: false, open: '18:00', close: '23:00' } };
  const rule = (startTime: string, endTime: string) => ({ daysOfWeek: [], startTime, endTime, kind: 'base' });

  it('asks for a price when the list misses every hour the venue is open', () => {
    expect(
      bookingBlockers({ weeklyHours: hours, ...placed }, [{ pricingRules: 1, rules: [rule('08:00', '17:00')] }]),
    ).toEqual(['prices']);
  });

  it('is fine when only part of the open hours is priced — that is a warning, not a blocker', () => {
    expect(
      bookingBlockers({ weeklyHours: hours, ...placed }, [{ pricingRules: 1, rules: [rule('18:00', '20:00')] }]),
    ).toEqual([]);
  });

  it('a temporary discount alone is not a price', () => {
    expect(
      bookingBlockers({ weeklyHours: hours, ...placed }, [
        { pricingRules: 1, rules: [{ ...rule('18:00', '23:00'), kind: 'discount' }] },
      ]),
    ).toEqual(['prices']);
  });
});

describe('venuePricingGaps', () => {
  it('names the court and the hours without a price, and skips fully priced courts', () => {
    const hours = { '0': { closed: false, open: '09:00', close: '23:45' } };
    const gaps = venuePricingGaps(hours, [
      { id: 'a', name: 'Court 1', rules: [{ daysOfWeek: [], startTime: '09:00', endTime: '23:00', kind: 'base' }] },
      { id: 'b', name: 'Court 2', rules: [{ daysOfWeek: [], startTime: '09:00', endTime: '24:00', kind: 'base' }] },
    ]);
    expect(gaps).toEqual([{ courtId: 'a', name: 'Court 1', gaps: [{ day: 0, from: '23:00', to: '23:45' }] }]);
  });

  it('says nothing for a venue with no hours yet (that is its own blocker)', () => {
    expect(venuePricingGaps(null, [{ id: 'a', name: 'Court 1', rules: [] }])).toEqual([]);
  });
});
