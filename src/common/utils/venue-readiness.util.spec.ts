import { bookingBlockers, hasOpeningHours } from './venue-readiness.util';

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
