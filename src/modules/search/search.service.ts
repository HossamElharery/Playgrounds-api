import { Injectable, Logger } from '@nestjs/common';
import { AiProviderService } from '../ai/ai-provider.service';
import { AiContextService } from '../ai/ai-context.service';
import { AiUnavailableError } from '../ai/ai-provider.types';
import { VenuesService } from '../venues/venues.service';
import type { SearchVenuesDto } from '../venues/dto/search-venues.dto';
import { SmartSearchDto } from './dto/smart-search.dto';
import { ParsedSearchIntent, SmartSearchResult } from './smart-search.types';

const SESSION_TTL_MS = 10 * 60_000;
/** Price cap used for a "cheap" preference — 2000 EGP in piasters, matching how prices are stored elsewhere. */
const CHEAP_PRICE_MAX = 200_000;
/** Default search radius for a "near me" request, once we actually have coordinates for it. */
const NEAR_ME_RADIUS_KM = 8;
/** How far ahead one venue's rating must lead the runner-up before we redirect instead of showing choices. */
const DOMINANT_RATING_GAP = 0.5;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sport: { type: 'STRING', nullable: true },
    district: { type: 'STRING', nullable: true },
    nearMe: { type: 'BOOLEAN' },
    cheap: { type: 'BOOLEAN' },
    timeHint: { type: 'STRING', enum: ['now', 'tonight', 'none'] },
    confidence: { type: 'NUMBER' },
  },
  required: ['nearMe', 'cheap', 'timeHint', 'confidence'],
};

const SYSTEM_PROMPT = `أنت تفهم طلب لاعب بيدور على ملعب في مصر، مكتوب بالعامية المصرية أو الفصحى.
استخرج من الجملة: sport و district (اختَرهم من الـ slugs اللي هتتبعتلك حرفيًا بس — لو مش متأكد أو مش موجودين في القايمة رجّع null، ماتخترعش slug جديد)، nearMe (لو قال "قريب مني" أو حاجة شبهها)، cheap (لو طلب سعر رخيص/اقتصادي)، timeHint ("now" لو دلوقتي، "tonight" لو الليلة، وإلا "none").
رجّع JSON فقط يطابق الـ schema بالظبط.`;

interface VenueCardLite {
  slug: string;
  nameAr: string;
  nameEn: string;
  ratingAvg: number;
  instantBook: boolean;
}

/**
 * Turns a free-text player query into real venue results by reusing the
 * same /venues/search infrastructure the rest of the platform already uses
 * — the AI only proposes filters, the real database result count decides
 * whether to redirect, show choices, or say "nothing found".
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly sessions = new Map<string, { filters: ParsedSearchIntent; expiresAt: number }>();

  constructor(
    private readonly aiProvider: AiProviderService,
    private readonly aiContext: AiContextService,
    private readonly venues: VenuesService,
  ) {}

  async smartSearch(dto: SmartSearchDto): Promise<SmartSearchResult> {
    let parsed: ParsedSearchIntent;
    try {
      parsed = await this.parseIntent(dto.text);
    } catch (err) {
      if (err instanceof AiUnavailableError) return { mode: 'unavailable' };
      this.logger.warn(`Smart search parse failed: ${err}`);
      return { mode: 'unavailable' };
    }

    const merged = this.mergeWithSession(dto.sessionId, parsed);
    return this.resolve(merged, dto);
  }

  private async parseIntent(text: string): Promise<ParsedSearchIntent> {
    const context = await this.aiContext.buildPlatformContext();
    const { raw } = await this.aiProvider.getStructuredIntent({
      systemPrompt: `${SYSTEM_PROMPT}\n\n${context}`,
      userPrompt: text.slice(0, 200),
      responseSchema: RESPONSE_SCHEMA,
    });
    return this.validate(raw);
  }

  /** Never trust the model's own claims — sport/district must be a real slug or they're dropped. */
  private async validate(raw: string): Promise<ParsedSearchIntent> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const { sports, districts } = await this.aiContext.listValidSlugs();
    const sport = typeof p['sport'] === 'string' && sports.has(p['sport']) ? (p['sport'] as string) : null;
    const district =
      typeof p['district'] === 'string' && districts.has(p['district']) ? (p['district'] as string) : null;
    const timeHint = p['timeHint'] === 'now' || p['timeHint'] === 'tonight' ? p['timeHint'] : null;
    return { sport, district, nearMe: Boolean(p['nearMe']), cheap: Boolean(p['cheap']), timeHint };
  }

  /**
   * Session-scoped memory only — no fine-tuning, no cross-session storage.
   * A follow-up that shares a topic with the stored filters is merged into
   * it; a request that clearly changes both sport AND district starts over.
   */
  private mergeWithSession(sessionId: string, parsed: ParsedSearchIntent): ParsedSearchIntent {
    this.sweepExpiredSessions();
    const prior = this.sessions.get(sessionId)?.filters;
    const isNewTopic =
      !!prior &&
      !!parsed.sport &&
      !!prior.sport &&
      parsed.sport !== prior.sport &&
      !!parsed.district &&
      !!prior.district &&
      parsed.district !== prior.district;

    const merged: ParsedSearchIntent =
      prior && !isNewTopic
        ? {
            sport: parsed.sport ?? prior.sport,
            district: parsed.district ?? prior.district,
            nearMe: parsed.nearMe || prior.nearMe,
            cheap: parsed.cheap || prior.cheap,
            timeHint: parsed.timeHint ?? prior.timeHint,
          }
        : parsed;

    this.sessions.set(sessionId, { filters: merged, expiresAt: Date.now() + SESSION_TTL_MS });
    return merged;
  }

  private sweepExpiredSessions(): void {
    const now = Date.now();
    for (const [key, value] of this.sessions) {
      if (value.expiresAt <= now) this.sessions.delete(key);
    }
  }

  private async resolve(filters: ParsedSearchIntent, dto: SmartSearchDto): Promise<SmartSearchResult> {
    const hasCoords = filters.nearMe && typeof dto.lat === 'number' && typeof dto.lng === 'number';
    const query: SearchVenuesDto = {
      sport: filters.sport ?? undefined,
      district: hasCoords ? undefined : (filters.district ?? undefined),
      center: hasCoords ? `${dto.lat},${dto.lng}` : undefined,
      radiusKm: hasCoords ? NEAR_ME_RADIUS_KM : undefined,
      priceMax: filters.cheap ? CHEAP_PRICE_MAX : undefined,
      sort: hasCoords ? 'distance' : 'rating',
      pageSize: 3,
      include: 'cards,count',
    } as SearchVenuesDto;

    const result = await this.venues.searchExplore(query);
    const items = (result.cards?.items ?? []) as VenueCardLite[];

    if (result.count === 0) {
      const broadenedFilters: Partial<ParsedSearchIntent> = filters.cheap
        ? { cheap: false }
        : filters.district
          ? { district: null }
          : {};
      return { mode: 'empty', filters, broadenedFilters };
    }

    const dominant = this.dominantVenue(items);
    if (result.count === 1 || dominant) {
      const v = dominant ?? items[0];
      return { mode: 'redirect', venue: { slug: v.slug, nameAr: v.nameAr, nameEn: v.nameEn } };
    }

    return {
      mode: 'choices',
      items: items.slice(0, 3).map((v) => ({
        slug: v.slug,
        nameAr: v.nameAr,
        nameEn: v.nameEn,
        reasonAr: this.reason(v, filters, 'ar'),
        reasonEn: this.reason(v, filters, 'en'),
      })),
    };
  }

  private dominantVenue(items: VenueCardLite[]): VenueCardLite | null {
    if (items.length < 2) return null;
    const [first, second] = items;
    return first.ratingAvg - second.ratingAvg >= DOMINANT_RATING_GAP ? first : null;
  }

  /** Built from real data about the venue and the request — never from the model's own prose. */
  private reason(v: VenueCardLite, filters: ParsedSearchIntent, lang: 'ar' | 'en'): string {
    const parts: string[] = [];
    if (filters.district) parts.push(lang === 'ar' ? 'في المنطقة اللي طلبتها' : 'in the area you asked for');
    if (v.instantBook) parts.push(lang === 'ar' ? 'حجز فوري متاح' : 'instant booking available');
    if (v.ratingAvg >= 4.5) {
      parts.push(lang === 'ar' ? `تقييم عالي (${v.ratingAvg.toFixed(1)})` : `highly rated (${v.ratingAvg.toFixed(1)})`);
    }
    return parts.length ? parts.join(' · ') : lang === 'ar' ? 'قريب من طلبك' : 'a close match for your search';
  }
}
