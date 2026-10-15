import { indexDecision, landingStats, nearestPlaces, summarizeHours, type LandingVenueFacts } from './local-landing.util';

const venue = (id: string, extra: Partial<LandingVenueFacts> = {}): LandingVenueFacts => ({
  id, priceFromAmount: 40000, ratingAvg: 0, ratingCount: 0, instantBook: true, hasPhoto: true, sportSlugs: ['football'], hours: null, ...extra,
});

describe('local landing rules', () => {
  it('keeps thin and photo-less places out of the index', () => {
    expect(indexDecision({ kind: 'area', venues: [venue('a')] })).toEqual({ indexable: false, reason: 'thin' });
    expect(indexDecision({ kind: 'area', venues: [venue('a', { hasPhoto: false }), venue('b', { hasPhoto: false })] }).reason).toBe('no-photos');
    expect(indexDecision({ kind: 'area', venues: [venue('a'), venue('b')] })).toEqual({ indexable: true, reason: 'ok' });
    expect(indexDecision({ kind: 'country', venues: [venue('a')] }).indexable).toBe(true);
  });

  it('defers a sport page that only repeats a single-sport parent', () => {
    const list = [venue('a'), venue('b')];
    expect(indexDecision({ kind: 'area-sport', venues: list, parentCount: 2, parentSportCount: 1 }).reason).toBe('same-as-parent');
    expect(indexDecision({ kind: 'area-sport', venues: list, parentCount: 3, parentSportCount: 2 }).indexable).toBe(true);
  });

  it('summarizes hours across the week, including overnight closing', () => {
    const hours = summarizeHours({
      0: { open: '09:00', close: '23:00' }, 1: { open: '08:00', close: '02:00' }, 2: { closed: true },
    });
    expect(hours).toEqual({ openDays: 2, earliestOpen: '08:00', latestClose: '02:00', latestCloseRank: 26 * 60, lateNight: true });
    expect(summarizeHours(null)).toBeNull();
  });

  it('builds stats from real prices and ratings', () => {
    const stats = landingStats([
      venue('a', { priceFromAmount: 30000, ratingAvg: 4, ratingCount: 1 }),
      venue('b', { priceFromAmount: 50000, ratingAvg: 5, ratingCount: 3, instantBook: false }),
      venue('c', { priceFromAmount: null }),
    ]);
    expect(stats).toMatchObject({ venueCount: 3, priceMin: 30000, priceMax: 50000, priceMedian: 30000, ratingAvg: 4.8, reviewCount: 4, instantBookCount: 2 });
  });

  it('lists nearest places without the origin', () => {
    const near = nearestPlaces({ id: 'o', lat: 30, lng: 31 }, [
      { id: 'o', lat: 30, lng: 31 }, { id: 'far', lat: 31, lng: 31 }, { id: 'b', lat: 30.05, lng: 31 }, { id: 'a', lat: 30.01, lng: 31 },
    ]);
    expect(near.map((p) => p.id)).toEqual(['a', 'b']);
  });
});
