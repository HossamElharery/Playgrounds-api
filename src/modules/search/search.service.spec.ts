import { SearchService } from './search.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { AiContextService } from '../ai/ai-context.service';
import { AiUnavailableError } from '../ai/ai-provider.types';
import { VenuesService } from '../venues/venues.service';

const VALID_SLUGS = { sports: new Set(['padel', 'football']), districts: new Set(['zamalek', 'maadi']) };

function makeService(opts: {
  raw: string;
  searchExploreResult?: unknown;
}) {
  const aiProvider = {
    getStructuredIntent: jest.fn().mockResolvedValue({ raw: opts.raw, provider: 'gemini' }),
  } as unknown as AiProviderService;
  const aiContext = {
    buildPlatformContext: jest.fn().mockResolvedValue('context'),
    listValidSlugs: jest.fn().mockResolvedValue(VALID_SLUGS),
  } as unknown as AiContextService;
  const venues = {
    searchExplore: jest.fn().mockResolvedValue(
      opts.searchExploreResult ?? { count: 0, cards: { items: [] } },
    ),
  } as unknown as VenuesService;
  return { service: new SearchService(aiProvider, aiContext, venues), aiProvider, aiContext, venues };
}

const VENUE_A = { slug: 'venue-a', nameAr: 'الملعب أ', nameEn: 'Venue A', ratingAvg: 4.8, instantBook: true };
const VENUE_B = { slug: 'venue-b', nameAr: 'الملعب ب', nameEn: 'Venue B', ratingAvg: 4.6, instantBook: false };
const VENUE_C = { slug: 'venue-c', nameAr: 'الملعب ج', nameEn: 'Venue C', ratingAvg: 4.5, instantBook: false };

describe('SearchService', () => {
  it('redirects when exactly one venue matches', async () => {
    const { service } = makeService({
      raw: JSON.stringify({ sport: 'padel', district: 'maadi', nearMe: false, cheap: false, timeHint: 'tonight', confidence: 0.9 }),
      searchExploreResult: { count: 1, cards: { items: [VENUE_A] } },
    });
    const result = await service.smartSearch({ text: 'عايز ملعب بادل الليلة في المعادي', sessionId: 'sess-1' });
    expect(result).toEqual({ mode: 'redirect', venue: { slug: 'venue-a', nameAr: 'الملعب أ', nameEn: 'Venue A' } });
  });

  it('redirects when one venue clearly dominates the rest on rating', async () => {
    const { service } = makeService({
      raw: JSON.stringify({ sport: 'padel', district: null, nearMe: false, cheap: false, timeHint: null, confidence: 0.8 }),
      searchExploreResult: { count: 3, cards: { items: [{ ...VENUE_A, ratingAvg: 5.0 }, VENUE_C, VENUE_C] } },
    });
    const result = await service.smartSearch({ text: 'بادل', sessionId: 'sess-2' });
    expect(result.mode).toBe('redirect');
  });

  it('shows up to 3 close choices with a data-driven reason each', async () => {
    const { service } = makeService({
      raw: JSON.stringify({ sport: 'football', district: 'zamalek', nearMe: false, cheap: false, timeHint: null, confidence: 0.7 }),
      searchExploreResult: { count: 3, cards: { items: [VENUE_A, VENUE_B, VENUE_C] } },
    });
    const result = await service.smartSearch({ text: 'كورة في الزمالك', sessionId: 'sess-3' });
    expect(result.mode).toBe('choices');
    if (result.mode === 'choices') {
      expect(result.items).toHaveLength(3);
      expect(result.items[0].reasonAr).toContain('المنطقة');
      expect(result.items[0].reasonEn).toBeTruthy();
    }
  });

  it('returns empty with a broadened suggestion when nothing matches', async () => {
    const { service } = makeService({
      raw: JSON.stringify({ sport: 'padel', district: 'zamalek', nearMe: false, cheap: true, timeHint: null, confidence: 0.6 }),
      searchExploreResult: { count: 0, cards: { items: [] } },
    });
    const result = await service.smartSearch({ text: 'بادل رخيص في الزمالك', sessionId: 'sess-4' });
    expect(result).toEqual({
      mode: 'empty',
      filters: { sport: 'padel', district: 'zamalek', nearMe: false, cheap: true, timeHint: null },
      broadenedFilters: { cheap: false },
    });
  });

  it('drops a sport/district slug the model invented that is not in the real list', async () => {
    const { service, venues } = makeService({
      raw: JSON.stringify({ sport: 'made-up-sport', district: 'nowhere', nearMe: false, cheap: false, timeHint: null, confidence: 0.9 }),
      searchExploreResult: { count: 0, cards: { items: [] } },
    });
    await service.smartSearch({ text: 'x', sessionId: 'sess-5' });
    const query = (venues.searchExplore as jest.Mock).mock.calls[0][0];
    expect(query.sport).toBeUndefined();
    expect(query.district).toBeUndefined();
  });

  it('returns {mode: unavailable} instead of throwing when every AI provider is down', async () => {
    const aiProvider = {
      getStructuredIntent: jest.fn().mockRejectedValue(new AiUnavailableError()),
    } as unknown as AiProviderService;
    const aiContext = {
      buildPlatformContext: jest.fn().mockResolvedValue('context'),
      listValidSlugs: jest.fn().mockResolvedValue(VALID_SLUGS),
    } as unknown as AiContextService;
    const venues = { searchExplore: jest.fn() } as unknown as VenuesService;
    const service = new SearchService(aiProvider, aiContext, venues);
    const result = await service.smartSearch({ text: 'x', sessionId: 'sess-6' });
    expect(result).toEqual({ mode: 'unavailable' });
    expect(venues.searchExplore).not.toHaveBeenCalled();
  });

  it('remembers a district from one turn and merges it with a sport-only follow-up', async () => {
    const aiProvider = {
      getStructuredIntent: jest
        .fn()
        .mockResolvedValueOnce({
          raw: JSON.stringify({ sport: null, district: 'zamalek', nearMe: false, cheap: false, timeHint: null, confidence: 0.7 }),
          provider: 'gemini',
        })
        .mockResolvedValueOnce({
          raw: JSON.stringify({ sport: 'padel', district: null, nearMe: false, cheap: false, timeHint: null, confidence: 0.7 }),
          provider: 'gemini',
        }),
    } as unknown as AiProviderService;
    const aiContext = {
      buildPlatformContext: jest.fn().mockResolvedValue('context'),
      listValidSlugs: jest.fn().mockResolvedValue(VALID_SLUGS),
    } as unknown as AiContextService;
    const venues = {
      searchExplore: jest.fn().mockResolvedValue({ count: 1, cards: { items: [VENUE_A] } }),
    } as unknown as VenuesService;
    const service = new SearchService(aiProvider, aiContext, venues);

    await service.smartSearch({ text: 'عايز ملعب في الزمالك', sessionId: 'sess-7' });
    await service.smartSearch({ text: 'وكمان بادل', sessionId: 'sess-7' });

    const secondQuery = (venues.searchExplore as jest.Mock).mock.calls[1][0];
    expect(secondQuery.district).toBe('zamalek');
    expect(secondQuery.sport).toBe('padel');
  });
});
