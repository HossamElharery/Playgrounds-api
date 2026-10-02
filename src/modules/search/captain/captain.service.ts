import { Injectable, Logger, Optional } from '@nestjs/common';
import { currencyLabel } from '../../../common/money/currency-label';
import { ConfigService } from '@nestjs/config';
import type { AiQuestionOutcome } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiContextService } from '../../ai/ai-context.service';
import { AiQuotaService, type QuotaRule } from '../../ai/ai-quota.service';
import { AiUsageService } from '../../ai/ai-usage.service';
import { AiSettingsService, type AiSettingKey } from '../../ai/ai-settings.service';
import { AiLogService } from '../../ai/ai-log.service';
import { TurnstileService } from '../../ai/turnstile.service';
import { AssistantKnowledgeService } from '../../ai/knowledge/assistant-knowledge.service';
import { KNOWLEDGE, type KnowledgeEntry } from '../../ai/knowledge/default-knowledge';
import { filterKnowledgeByFlags } from '../../ai/knowledge/knowledge-flags';
import { VenuesService } from '../../venues/venues.service';
import type { SearchVenuesDto } from '../../venues/dto/search-venues.dto';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { CaptainNluService } from './captain-nlu.service';
import { CaptainAskDto } from './captain.dto';
import { screenMessage } from './captain-guard';
import {
  bestFaq,
  EMPTY_FILTERS,
  heuristicReading,
  safeAppPath,
  type CatalogNames,
  type FaqRow,
} from './captain-text';
import type {
  CaptainBookingRef,
  CaptainCta,
  CaptainCtaKind,
  CaptainFilters,
  CaptainReading,
  CaptainReply,
  CaptainVenueCard,
} from './captain.types';

const NEAR_ME_RADIUS_KM = 8;
const RESULT_COUNT = 5;
const FAQ_TTL_MS = 5 * 60_000;

interface Card {
  slug: string;
  nameAr: string;
  nameEn: string;
  ratingAvg: number;
  ratingCount: number;
  instantBook: boolean;
  hasOffers: boolean;
  photo: string | null;
  priceFrom: { amount: number; currency: string } | null;
  district: { nameAr: string; nameEn: string } | null;
}

/** What happened to one question, collected as it is answered and written to the admin log afterwards. */
interface Trace {
  outcome: AiQuestionOutcome;
  detail?: string;
  intent?: string;
  factIds: string[];
  loggedIn: boolean;
  reading?: CaptainReading;
  startedAt: number;
}

/**
 * The player's assistant. The model proposes a reading of the sentence; this
 * service is the part that knows what is true — which venues exist, what they
 * cost, what the player has booked, what the help center actually says — and
 * composes every answer from that, in the player's language.
 */
@Injectable()
export class CaptainService {
  private readonly logger = new Logger(CaptainService.name);
  private faqCache: { exp: number; rows: FaqRow[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly nlu: CaptainNluService,
    private readonly aiContext: AiContextService,
    private readonly venues: VenuesService,
    private readonly config: ConfigService,
    private readonly quota: AiQuotaService,
    private readonly usage: AiUsageService,
    @Optional() private readonly knowledgeStore?: AssistantKnowledgeService,
    @Optional() private readonly settings?: AiSettingsService,
    @Optional() private readonly logs?: AiLogService,
    @Optional() private readonly turnstile?: TurnstileService,
  ) {}

  /** Platform facts that are true in this deployment: a lobby feature that is switched off is not promised. */
  private async knowledge(): Promise<KnowledgeEntry[]> {
    if (this.knowledgeStore) return this.knowledgeStore.forPlayers();
    return filterKnowledgeByFlags(KNOWLEDGE, (name) => this.config.get<string>(name));
  }

  /** A limit: the admin's value, else the environment variable, else the default. */
  private limit(key: AiSettingKey, env: string, fallback: number): number {
    if (this.settings) return this.settings.number(key) ?? fallback;
    const n = Number(this.config.get<string>(env));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  /** Who may ask, and how often. A signed-in player gets far more room than a visitor, and a visitor gets less when the day's budget runs low. */
  private rulesFor(
    dto: CaptainAskDto,
    user: AuthenticatedUser | undefined,
    registered: boolean,
    ip: string | undefined,
    tight: boolean,
  ): QuotaRule[] {
    const ipKey = `ip:${ip || 'unknown'}`;
    if (registered && user) {
      return [
        {
          key: `user:${user.id}`,
          perMinute: this.limit('captainUserPerMinute', 'CAPTAIN_USER_PER_MINUTE', 10),
          perDay: this.limit('captainUserPerDay', 'CAPTAIN_USER_PER_DAY', 150),
        },
      ];
    }
    const guestDay = this.limit('captainGuestPerDay', 'CAPTAIN_GUEST_PER_DAY', 15);
    const rules: QuotaRule[] = [
      {
        key: ipKey,
        perMinute: this.limit('captainGuestIpPerMinute', 'CAPTAIN_GUEST_IP_PER_MINUTE', 10),
        // A whole café can share one address, so the address allowance is a multiple of one visitor's.
        perDay: this.limit('captainGuestIpPerDay', 'CAPTAIN_GUEST_IP_PER_DAY', guestDay * 4),
      },
    ];
    if (dto.deviceId) {
      rules.push({
        key: `dev:${dto.deviceId}`,
        perMinute: this.limit('captainGuestPerMinute', 'CAPTAIN_GUEST_PER_MINUTE', 5),
        perDay: tight || this.usage.publicUnderPressure() ? Math.max(3, Math.floor(guestDay / 3)) : guestDay,
      });
    }
    return rules;
  }

  async ask(dto: CaptainAskDto, user: AuthenticatedUser | undefined, ip?: string): Promise<CaptainReply> {
    const trace: Trace = { outcome: 'unavailable', factIds: [], loggedIn: false, startedAt: Date.now() };
    let reply: CaptainReply;
    try {
      reply = await this.run(dto, user, ip, trace);
    } catch (err) {
      this.logger.warn(`captain failed: ${err}`);
      const ar = (dto.lang ?? (/[؀-ۿ]/.test(dto.text) ? 'ar' : 'en')) === 'ar';
      trace.outcome = 'unavailable';
      trace.detail = 'error';
      reply = this.reply('unavailable', 'unknown', ar ? 'حصلت مشكلة عندي. جرّب تاني بعد شوية.' : 'Something went wrong on my side. Try again in a moment.');
    }
    reply.logId = this.record(dto, user, ip, trace, reply);
    return reply;
  }

  /** The admin's view of this exchange: redacted text, what was understood, what answered, what it cost. Never delays the reply. */
  private record(dto: CaptainAskDto, user: AuthenticatedUser | undefined, ip: string | undefined, trace: Trace, reply: CaptainReply): string | null {
    if (!this.logs) return null;
    try {
      const r = trace.reading;
      return this.logs.logQuestion({
        userKind: trace.loggedIn ? 'player' : 'guest',
        text: dto.text,
        lang: dto.lang ?? (/[؀-ۿ]/.test(dto.text) ? 'ar' : 'en'),
        intent: trace.intent ?? reply.intent,
        outcome: trace.outcome,
        detail: trace.detail,
        factIds: trace.factIds,
        reading: r
          ? {
              intent: r.intent,
              sport: r.sport,
              district: r.district,
              nearMe: r.nearMe,
              cheap: r.cheap,
              priceMax: r.priceMax,
              minRating: r.minRating,
              instantOnly: r.instantOnly,
              sort: r.sort,
              timeHint: r.timeHint,
              followUp: r.followUp,
              confidence: r.confidence,
              topic: r.topic,
            }
          : undefined,
        model: r?.meta?.model ?? null,
        ms: r?.meta?.ms ?? Date.now() - trace.startedAt,
        costUsd: r?.meta?.costUsd ?? 0,
        askerKey: user?.id ? `user:${user.id}` : dto.deviceId ? `dev:${dto.deviceId}` : `ip:${ip || 'unknown'}`,
        userId: trace.loggedIn && user?.id ? user.id : undefined,
        replyText: reply.reply,
      });
    } catch (err) {
      this.logger.warn(`could not log a question: ${err}`);
      return null;
    }
  }

  private async run(dto: CaptainAskDto, user: AuthenticatedUser | undefined, ip: string | undefined, trace: Trace): Promise<CaptainReply> {
    const lang: 'ar' | 'en' = dto.lang ?? (/[؀-ۿ]/.test(dto.text) ? 'ar' : 'en');
    const t = (ar: string, en: string) => (lang === 'ar' ? ar : en);
    const history = (dto.history ?? []).map((h) => ({ from: h.from, text: h.text }));

    // 1) Is this even a message? No model is paid for nonsense.
    const screened = screenMessage(
      dto.text,
      history.filter((h) => h.from === 'player').map((h) => h.text),
    );
    if (!screened.ok) {
      trace.outcome = 'blocked';
      trace.detail = screened.reason;
      return this.reply(
        'clarify',
        'unknown',
        screened.reason === 'spam'
          ? t('لسه شايف نفس الرسالة. قولّي عايز تلعب إيه وفين وأنا أدورلك.', 'I keep getting the same message. Tell me what you want to play and where, and I will search.')
          : t('مفهمتش الرسالة دي. اكتب نوع الرياضة والمنطقة وأنا أدورلك.', 'I did not understand that. Type the sport and the area and I will search.'),
        { suggestions: [t('بادل في المعادي', 'Padel in Maadi'), t('حجوزاتي', 'My bookings'), t('إزاي أحجز؟', 'How do I book?')] },
      );
    }

    const loggedIn = await this.isRegistered(user);
    trace.loggedIn = loggedIn;

    // 2) A visitor can be switched off from the admin, and one who looks automated must prove they are not.
    let tight = false;
    if (!loggedIn) {
      if (this.settings && !this.settings.flag('captainGuestsEnabled')) {
        trace.outcome = 'limited';
        trace.detail = 'guests_off';
        return this.reply(
          'limited',
          'unknown',
          t('كابتن متاح للمسجلين بس دلوقتي. سجّل دخول وكمّل معايا، أو دوّر بالفلاتر من صفحة الملاعب.', 'Captain is for signed-in players right now. Sign in to continue, or search with the filters on the venues page.'),
          { cta: { kind: 'login', label: t('تسجيل الدخول', 'Sign in') } },
        );
      }
      if (this.turnstile?.enabled) {
        const challenged = await this.challengeVisitor(dto, ip, trace, t);
        if (challenged === 'tight') tight = true;
        else if (challenged) return challenged;
      }
    }

    // 3) How many may this visitor ask today?
    const verdict = await this.quota.take('captain', this.rulesFor(dto, user, loggedIn, ip, tight));
    if (!verdict.ok) {
      this.logger.warn(`[captain-limit] ${verdict.reason} for ${verdict.key.split(':')[0]} (${loggedIn ? 'player' : 'visitor'})`);
      trace.outcome = 'limited';
      trace.detail = verdict.reason;
      const wait = Math.min(verdict.retryAfterSec, 90);
      return this.reply(
        'limited',
        'unknown',
        verdict.reason === 'minute'
          ? t(`على مهلك شوية، استنى ${wait} ثانية وابعت تاني.`, `Slow down a little: wait ${wait} seconds and send again.`)
          : loggedIn
            ? t('وصلت للحد اليومي لأسئلة كابتن. تقدر تكمّل بالبحث بالفلاتر من صفحة الملاعب، وبكرة هنكون جاهزين.', 'You have reached today’s Captain limit. You can keep searching with the filters on the venues page, and Captain is back tomorrow.')
            : t('وصلت للحد اليومي لأسئلة الزوار. سجّل دخول عشان تكمّل بحدود أكبر، أو كمّل بحث بالفلاتر من صفحة الملاعب.', 'You have reached the daily limit for visitors. Sign in to continue with a bigger allowance, or keep searching with the filters on the venues page.'),
        { cta: loggedIn ? { kind: 'explore', label: t('استكشف الملاعب', 'Explore venues') } : { kind: 'login', label: t('تسجيل الدخول', 'Sign in') } },
      );
    }

    const catalog = await this.aiContext.listCatalog();
    const hasCoords = typeof dto.lat === 'number' && typeof dto.lng === 'number';
    const context = this.sanitizeContext(dto.context, catalog);
    const knowledge = await this.knowledge();

    let reading = await this.nlu.read({
      text: dto.text,
      lang,
      loggedIn,
      hasCoords,
      history,
      context,
      knowledge,
    });
    const modelAnswered = !!reading;
    reading ??= heuristicReading(dto.text, catalog);
    trace.reading = reading;
    trace.intent = reading.intent;

    const base: Base = { lang, t, catalog, loggedIn, hasCoords, coords: hasCoords ? { lat: dto.lat!, lng: dto.lng! } : null, knowledge, trace };
    try {
      switch (reading.intent) {
        case 'find_venues':
          return await this.findVenues(reading, context, base);
        case 'my_bookings':
          return await this.myBookings(user, loggedIn, base);
        case 'faq':
          return await this.answerFaq(reading, dto.text, base);
        case 'players':
        case 'chat':
        case 'community':
        case 'tonight':
        case 'help':
        case 'login':
        case 'explore':
          return this.navigate(reading.intent, loggedIn, base);
        case 'smalltalk':
        case 'unknown':
        default:
          return this.chat(reading, modelAnswered, context, base);
      }
    } catch (err) {
      this.logger.warn(`captain failed (${reading.intent}): ${err}`);
      trace.outcome = 'unavailable';
      trace.detail = 'error';
      return this.reply('unavailable', reading.intent, t('حصلت مشكلة عندي. جرّب تاني بعد شوية.', 'Something went wrong on my side. Try again in a moment.'), {
        context,
      });
    }
  }

  /**
   * Turnstile for a visitor who looks automated. Returns a reply to send
   * instead of answering, `'tight'` when Cloudflare could not be reached (carry
   * on under a tighter allowance), or null when nothing is needed.
   */
  private async challengeVisitor(
    dto: CaptainAskDto,
    ip: string | undefined,
    trace: Trace,
    t: (ar: string, en: string) => string,
  ): Promise<CaptainReply | 'tight' | null> {
    const turnstile = this.turnstile!;
    const ask = (detail: string): CaptainReply => {
      trace.outcome = 'blocked';
      trace.detail = detail;
      return this.reply(
        'challenge',
        'unknown',
        t('عشان نتأكد إنك مش برنامج آلي، كمّل التحقق السريع ده وهكمل معاك.', 'To make sure you are not a bot, complete this quick check and I will carry on.'),
        { needsChallenge: true },
      );
    };
    if (dto.challengeToken) {
      const result = await turnstile.verify(dto.challengeToken, ip);
      if (result === 'ok') {
        turnstile.markVerified(ip, dto.deviceId);
        return null;
      }
      if (result === 'failed') return ask('challenge_failed');
      return 'tight';
    }
    if (turnstile.isVerified(ip, dto.deviceId)) return null;
    const why = await turnstile.suspicion(ip, dto.deviceId);
    return why ? ask(`challenge_${why}`) : null;
  }

  // ------------------------------------------------------------ venues ----

  private async findVenues(
    reading: CaptainReading,
    prior: CaptainFilters | null,
    b: Base,
  ): Promise<CaptainReply> {
    const filters = this.mergeFilters(reading, prior);
    const nearRequested = filters.nearMe;
    const useNear = nearRequested && !!b.coords;
    const needsLocation = nearRequested && !b.coords;

    const hasStrict =
      filters.cheap || filters.priceMax !== null || filters.minRating !== null || filters.instantOnly;
    const attempts: Array<{
      f: CaptainFilters;
      near: boolean;
      relaxed: CaptainReply['relaxed'];
    }> = [{ f: filters, near: useNear, relaxed: [] }];
    if (hasStrict) {
      const relaxed: CaptainReply['relaxed'] = [];
      if (filters.priceMax !== null) relaxed.push('price');
      if (filters.minRating !== null) relaxed.push('rating');
      if (filters.instantOnly) relaxed.push('instant');
      attempts.push({
        f: { ...filters, priceMax: null, minRating: null, instantOnly: false },
        near: useNear,
        relaxed: relaxed.length ? relaxed : [],
      });
    }
    if (filters.district || useNear) {
      attempts.push({
        f: { ...filters, district: null, priceMax: null, minRating: null, instantOnly: false },
        near: false,
        relaxed: ['district'],
      });
    }

    for (const attempt of attempts) {
      const cards = await this.search(attempt.f, attempt.near, b.coords);
      if (!cards.length) continue;
      // A relaxed attempt that changed nothing visible is not worth announcing.
      const relaxed = attempt.relaxed;
      const shown = cards.map((c) => this.toCard(c, attempt.f, b.lang));
      b.trace.outcome = 'venues';
      return this.reply('venues', 'find_venues', this.venuesLine(shown, attempt.f, relaxed, b), {
        venues: shown,
        context: filters,
        needsLocation,
        relaxed,
        suggestions: this.venueSuggestions(filters, b),
        cta: { kind: 'explore', label: b.t('كل الأماكن', 'See all venues') },
      });
    }

    b.trace.outcome = needsLocation ? 'clarify' : 'no_results';
    if (needsLocation) b.trace.detail = 'needs_location';
    return this.reply(
      'answer',
      'find_venues',
      needsLocation
        ? b.t('عشان أقولك الأقرب محتاج أعرف مكانك. فعّل الموقع وأنا أدورلك.', 'To find the nearest I need your location. Turn it on and I will look.')
        : b.t(
            `مالقيتش حاجة${this.scopeText(filters, b)} حاليًا. جرّب رياضة تانية أو منطقة أقرب.`,
            `I could not find anything${this.scopeText(filters, b)} right now. Try another sport or a nearby area.`,
          ),
      {
        context: filters,
        needsLocation,
        suggestions: this.emptySuggestions(b),
        cta: { kind: 'explore', label: b.t('استكشف كل الأماكن', 'Browse all venues') },
      },
    );
  }

  private async search(
    f: CaptainFilters,
    near: boolean,
    coords: { lat: number; lng: number } | null,
  ): Promise<Card[]> {
    const sort =
      f.sort === 'distance' && near
        ? 'distance'
        : f.sort === 'price' || f.cheap
          ? 'price'
          : f.sort === 'rating'
            ? 'rating'
            : near
              ? 'distance'
              : 'rating';
    const query = {
      sport: f.sport ?? undefined,
      district: near ? undefined : (f.district ?? undefined),
      center: near && coords ? `${coords.lat},${coords.lng}` : undefined,
      radiusKm: near ? NEAR_ME_RADIUS_KM : undefined,
      // Prices are stored in whole EGP, so a stated ceiling is passed as said.
      priceMax: f.priceMax ?? undefined,
      ratingMin: f.minRating ?? undefined,
      instantBook: f.instantOnly ? true : undefined,
      sort,
      pageSize: RESULT_COUNT,
      include: 'cards,count',
    } as unknown as SearchVenuesDto;
    const result = await this.venues.searchExplore(query);
    return ((result.cards?.items ?? []) as unknown[]).map((raw) => {
      const v = raw as Record<string, unknown>;
      const price = v['priceFrom'] as { amount: number; currency: string } | undefined;
      const d = v['district'] as { nameAr: string; nameEn: string } | null;
      return {
        slug: String(v['slug']),
        nameAr: String(v['nameAr']),
        nameEn: String(v['nameEn']),
        ratingAvg: Number(v['ratingAvg'] ?? 0),
        ratingCount: Number(v['ratingCount'] ?? 0),
        instantBook: v['instantBook'] === true,
        hasOffers: v['hasOffers'] === true,
        photo: typeof v['photo'] === 'string' ? v['photo'] : null,
        priceFrom: price && price.amount > 0 ? price : null,
        district: d ? { nameAr: d.nameAr, nameEn: d.nameEn } : null,
      };
    });
  }

  private toCard(c: Card, f: CaptainFilters, lang: 'ar' | 'en'): CaptainVenueCard {
    const ar = lang === 'ar';
    const parts: string[] = [];
    if (f.district && c.district) parts.push(ar ? 'في المنطقة اللي طلبتها' : 'in the area you asked for');
    if (c.hasOffers) parts.push(ar ? 'عليه عرض' : 'has an offer');
    if (c.instantBook) parts.push(ar ? 'حجز فوري' : 'instant booking');
    if (c.ratingCount >= 3 && c.ratingAvg >= 4.5) {
      parts.push(ar ? `تقييم عالي (${c.ratingAvg.toFixed(1)})` : `highly rated (${c.ratingAvg.toFixed(1)})`);
    }
    return {
      slug: c.slug,
      nameAr: c.nameAr,
      nameEn: c.nameEn,
      reason: parts.length ? parts.join(' · ') : ar ? 'قريب من طلبك' : 'a close match',
      priceFrom: c.priceFrom,
      ratingAvg: c.ratingCount > 0 ? c.ratingAvg : null,
      ratingCount: c.ratingCount,
      districtAr: c.district?.nameAr ?? null,
      districtEn: c.district?.nameEn ?? null,
      instantBook: c.instantBook,
      hasOffers: c.hasOffers,
      photo: c.photo,
    };
  }

  private venuesLine(
    cards: CaptainVenueCard[],
    f: CaptainFilters,
    relaxed: CaptainReply['relaxed'],
    b: Base,
  ): string {
    const top = cards[0];
    const name = b.lang === 'ar' ? top.nameAr : top.nameEn;
    const n = cards.length;
    const price = top.priceFrom
      ? b.t(` وبيبدأ من ${top.priceFrom.amount} ${currencyAr(top.priceFrom.currency)}`, ` starting from ${top.priceFrom.amount} ${top.priceFrom.currency}`)
      : '';
    const scope = this.scopeText(f, b);
    let line: string;
    if (relaxed.includes('district')) {
      line = b.t(
        `مفيش${scope ? ' ' + scope.trim() : ''} بالظبط، بس دي أقرب بدائل:`,
        `Nothing${scope ? ' ' + scope.trim() : ''} exactly, but these are the closest options:`,
      );
    } else if (relaxed.length) {
      line = b.t(
        `مفيش حاجة بنفس كل الشروط${scope}، فخففت ${relaxedWords(relaxed, 'ar')} وده اللي لقيته:`,
        `Nothing matched every condition${scope}, so I loosened ${relaxedWords(relaxed, 'en')}:`,
      );
    } else if (n === 1) {
      line = b.t(`لقيتلك مكان واحد${scope}: ${name}${price}.`, `I found one place${scope}: ${name}${price}.`);
    } else {
      const lead = f.sort === 'price' || f.cheap ? b.t('الأرخص', 'the cheapest') : b.t('الأعلى ترتيبًا', 'the top pick');
      line = b.t(`لقيتلك ${n} أماكن${scope}. ${lead}: ${name}${price}.`, `I found ${n} places${scope}. ${lead}: ${name}${price}.`);
    }
    return line;
  }

  private scopeText(f: CaptainFilters, b: Base): string {
    const sport = b.catalog.sports.find((s) => s.slug === f.sport);
    const district = b.catalog.districts.find((d) => d.slug === f.district);
    const bits: string[] = [];
    if (sport) bits.push(b.lang === 'ar' ? sport.nameAr : sport.nameEn);
    if (district) bits.push(b.t(`في ${district.nameAr}`, `in ${district.nameEn}`));
    if (f.priceMax !== null) bits.push(b.t(`لحد ${f.priceMax} جنيه`, `up to ${f.priceMax} EGP`));
    if (f.timeHint === 'tonight') bits.push(b.t('الليلة', 'tonight'));
    return bits.length ? ' ' + bits.join(' ') : '';
  }

  private venueSuggestions(f: CaptainFilters, b: Base): string[] {
    const out: string[] = [];
    if (!f.cheap && f.sort !== 'price') out.push(b.t('أرخص من كده', 'Something cheaper'));
    if (!f.nearMe) out.push(b.t('الأقرب ليا', 'Closest to me'));
    if (f.sort !== 'rating') out.push(b.t('الأعلى تقييمًا', 'Top rated'));
    if (!f.instantOnly && out.length < 3) out.push(b.t('حجز فوري بس', 'Instant booking only'));
    return out.slice(0, 3);
  }

  private emptySuggestions(b: Base): string[] {
    return [
      b.t('بادل', 'Padel'),
      b.t('كورة', 'Football'),
      b.t('بلايستيشن', 'PlayStation'),
    ];
  }

  private mergeFilters(reading: CaptainReading, prior: CaptainFilters | null): CaptainFilters {
    const own: CaptainFilters = {
      sport: reading.sport,
      district: reading.district,
      nearMe: reading.nearMe,
      cheap: reading.cheap,
      priceMax: reading.priceMax,
      minRating: reading.minRating,
      instantOnly: reading.instantOnly,
      sort: reading.sort,
      timeHint: reading.timeHint,
    };
    if (!reading.followUp || !prior) return own;
    return {
      sport: own.sport ?? prior.sport,
      district: own.district ?? prior.district,
      nearMe: own.nearMe || prior.nearMe,
      cheap: own.cheap || prior.cheap,
      priceMax: own.priceMax ?? prior.priceMax,
      minRating: own.minRating ?? prior.minRating,
      instantOnly: own.instantOnly || prior.instantOnly,
      sort: own.sort ?? prior.sort,
      timeHint: own.timeHint ?? prior.timeHint,
    };
  }

  /** The client echoes the previous filters back, so they are untrusted input like any other. */
  private sanitizeContext(raw: Record<string, unknown> | undefined, catalog: CatalogNames): CaptainFilters | null {
    if (!raw || typeof raw !== 'object') return null;
    const sports = new Set(catalog.sports.map((s) => s.slug));
    const districts = new Set(catalog.districts.map((d) => d.slug));
    const num = (v: unknown, min: number, max: number) => {
      const n = Number(v);
      return v !== null && v !== '' && v !== undefined && Number.isFinite(n) && n >= min && n <= max ? n : null;
    };
    return {
      ...EMPTY_FILTERS,
      sport: typeof raw['sport'] === 'string' && sports.has(raw['sport']) ? raw['sport'] : null,
      district: typeof raw['district'] === 'string' && districts.has(raw['district']) ? raw['district'] : null,
      nearMe: raw['nearMe'] === true,
      cheap: raw['cheap'] === true,
      priceMax: num(raw['priceMax'], 10, 100_000),
      minRating: num(raw['minRating'], 1, 5),
      instantOnly: raw['instantOnly'] === true,
      sort: ['rating', 'price', 'distance'].includes(String(raw['sort']))
        ? (raw['sort'] as CaptainFilters['sort'])
        : null,
      timeHint: ['now', 'tonight', 'tomorrow'].includes(String(raw['timeHint']))
        ? (raw['timeHint'] as CaptainFilters['timeHint'])
        : null,
    };
  }

  // ---------------------------------------------------------- bookings ----

  private async myBookings(user: AuthenticatedUser | undefined, loggedIn: boolean, b: Base): Promise<CaptainReply> {
    if (!user || !loggedIn) {
      b.trace.outcome = 'nav';
      b.trace.detail = 'login_needed';
      return this.reply('answer', 'my_bookings', b.t('سجّل دخول الأول وأنا أوريك حجوزاتك.', 'Sign in first and I will show your bookings.'), {
        cta: { kind: 'login', label: b.t('تسجيل الدخول', 'Sign in') },
      });
    }
    const rows = await this.prisma.booking.findMany({
      where: { userId: user.id, status: { in: ['held', 'confirmed'] }, slotStart: { gte: new Date() } },
      orderBy: { slotStart: 'asc' },
      take: 3,
      select: {
        id: true,
        code: true,
        status: true,
        slotStart: true,
        venue: { select: { slug: true, nameAr: true, nameEn: true } },
        court: { select: { name: true } },
      },
    });
    b.trace.outcome = 'bookings';
    if (!rows.length) {
      return this.reply('answer', 'my_bookings', b.t('مفيش عندك حجوزات جاية. تحب أدورلك على ملعب؟', 'You have no upcoming bookings. Want me to find you a court?'), {
        cta: { kind: 'explore', label: b.t('دوّر على ملعب', 'Find a court') },
        suggestions: this.emptySuggestions(b),
      });
    }
    const bookings: CaptainBookingRef[] = rows.map((r) => ({
      id: r.id,
      code: r.code,
      venueSlug: r.venue.slug,
      venueNameAr: r.venue.nameAr,
      venueNameEn: r.venue.nameEn,
      courtName: r.court?.name ?? '',
      startsAt: r.slotStart.toISOString(),
      status: r.status,
    }));
    const next = bookings[0];
    const when = new Intl.DateTimeFormat(b.lang === 'ar' ? 'ar-EG' : 'en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'Africa/Cairo',
    }).format(new Date(next.startsAt));
    return this.reply(
      'bookings',
      'my_bookings',
      b.t(
        `حجزك الجاي في ${next.venueNameAr} ${when}.`,
        `Your next booking is at ${next.venueNameEn}, ${when}.`,
      ),
      { bookings, cta: { kind: 'bookings', label: b.t('كل حجوزاتي', 'All my bookings') } },
    );
  }

  // --------------------------------------------------------------- faq ----

  private async answerFaq(reading: CaptainReading, text: string, b: Base): Promise<CaptainReply> {
    // The facts the model picked, shown exactly as written. It chooses; it does not author.
    const known = new Map(b.knowledge.map((k) => [k.id, k]));
    const picked = reading.factIds.map((id) => known.get(id)).filter((k): k is KnowledgeEntry => !!k);
    if (picked.length) {
      b.trace.outcome = 'answered_fact';
      b.trace.factIds = picked.map((k) => k.id);
      const cta = picked.find((k) => k.cta)?.cta;
      return this.reply(
        'answer',
        'faq',
        picked.map((k) => (b.lang === 'ar' ? k.ar : k.en)).join('\n\n'),
        { cta: cta ? this.ctaFor(cta.target, b.lang === 'ar' ? cta.labelAr : cta.labelEn) : null },
      );
    }

    const rows = await this.faqRows();
    const hit = bestFaq(`${reading.topic} ${text}`, rows);
    if (!hit) {
      // The list of what players ask and Captain could not answer, for whoever maintains the help center.
      this.logger.log(`[captain-unanswered] ${JSON.stringify(text.replace(/\d{6,}/g, '#').slice(0, 160))}`);
      b.trace.outcome = 'unanswered';
      return this.reply(
        'answer',
        'faq',
        b.t(
          'مش لاقي إجابة مؤكدة للسؤال ده. تقدر تدور في مركز المساعدة أو تكلم الدعم وهيرجعولك.',
          'I could not find a confirmed answer to that. You can search the help center or write to support.',
        ),
        { cta: { kind: 'help', label: b.t('مركز المساعدة', 'Help center') } },
      );
    }
    b.trace.outcome = 'answered_faq';
    b.trace.detail = `faq:${hit.id}`.slice(0, 60);
    const answer = (b.lang === 'ar' ? hit.answerAr : hit.answerEn).replace(/\s+/g, ' ').trim();
    const path = safeAppPath(hit.ctaPath);
    const label = (b.lang === 'ar' ? hit.ctaLabelAr : hit.ctaLabelEn)?.trim();
    return this.reply('answer', 'faq', answer.length > 480 ? `${answer.slice(0, 477)}…` : answer, {
      cta: path
        ? { kind: 'path', target: path, label: label || b.t('افتح', 'Open') }
        : { kind: 'help', label: b.t('مركز المساعدة', 'Help center') },
    });
  }

  /** A knowledge entry's button: the named destinations the client already knows, or an in-app path. */
  private ctaFor(target: string, label: string): CaptainCta {
    const named: CaptainCtaKind[] = ['players', 'chat', 'community', 'tonight', 'bookings', 'help', 'login', 'explore'];
    if (named.includes(target as CaptainCtaKind)) return { kind: target as CaptainCtaKind, label };
    return { kind: 'path', target, label };
  }

  private async faqRows(): Promise<FaqRow[]> {
    if (this.faqCache && this.faqCache.exp > Date.now()) return this.faqCache.rows;
    const rows = await this.prisma.faqEntry.findMany({
      select: {
        id: true,
        questionAr: true,
        questionEn: true,
        answerAr: true,
        answerEn: true,
        ctaPath: true,
        ctaLabelAr: true,
        ctaLabelEn: true,
      },
    });
    this.faqCache = { exp: Date.now() + FAQ_TTL_MS, rows };
    return rows;
  }

  // --------------------------------------------------------- navigation ----

  private navigate(intent: CaptainCtaKind & CaptainReading['intent'], loggedIn: boolean, b: Base): CaptainReply {
    const needsLogin = ['players', 'chat', 'tonight'].includes(intent) && !loggedIn;
    b.trace.outcome = 'nav';
    if (needsLogin) {
      b.trace.detail = 'login_needed';
      return this.reply('answer', intent, b.t('الحاجة دي محتاجة حساب. سجّل دخول وأنا هاخدك عليها.', 'That needs an account. Sign in and I will take you there.'), {
        cta: { kind: 'login', label: b.t('تسجيل الدخول', 'Sign in') },
      });
    }
    const copy: Record<string, [string, string, string, string]> = {
      players: ['دوّر على لاعبين تلعب معاهم من صفحة اللاعبين.', 'Find people to play with on the players page.', 'اللاعبين', 'Players'],
      chat: ['محادثاتك كلها في الشات.', 'All your conversations are in chat.', 'افتح الشات', 'Open chat'],
      community: ['الفرق والمجتمع هناك.', 'Teams and the community live there.', 'المجتمع', 'Community'],
      tonight: ['شوف خطط الليلة واللي بيلعبوا دلوقتي.', 'See tonight’s plans and who is playing now.', 'الليلة', 'Tonight'],
      help: ['مركز المساعدة فيه الإجابات واتصال بالدعم.', 'The help center has answers and a way to reach support.', 'مركز المساعدة', 'Help center'],
      login: ['اتفضل سجّل دخولك.', 'Go ahead and sign in.', 'تسجيل الدخول', 'Sign in'],
      explore: ['تصفح كل الأماكن واختار بنفسك.', 'Browse all venues and pick for yourself.', 'استكشف', 'Explore'],
    };
    const [ar, en, labelAr, labelEn] = copy[intent];
    return this.reply('answer', intent, b.t(ar, en), {
      cta: { kind: intent as CaptainCtaKind, label: b.t(labelAr, labelEn) },
    });
  }

  // ------------------------------------------------------------- chat ----

  private chat(reading: CaptainReading, modelAnswered: boolean, context: CaptainFilters | null, b: Base): CaptainReply {
    const suggestions = [
      b.t('ملعب بادل قريب', 'A padel court near me'),
      b.t('حجوزاتي', 'My bookings'),
      b.t('إزاي أحجز؟', 'How do I book?'),
    ];
    if (reading.intent === 'smalltalk' && reading.reply) {
      b.trace.outcome = 'smalltalk';
      return this.reply('answer', 'smalltalk', reading.reply, { context, suggestions });
    }
    const line =
      reading.question ||
      (modelAnswered
        ? b.t('مفهمتش قصدك بالظبط. تحب أدورلك على ملعب، ولا أوريك حجوزاتك؟', 'I did not quite get that. Want me to find a court or show your bookings?')
        : b.t('مش قادر أفهم الكلام ده دلوقتي. اكتب نوع الرياضة والمنطقة وأنا أدورلك.', 'I cannot read that right now. Tell me the sport and the area and I will search.'));
    b.trace.outcome = 'clarify';
    return this.reply('clarify', 'unknown', line, { context, suggestions });
  }

  // ----------------------------------------------------------- helpers ----

  private async isRegistered(user: AuthenticatedUser | undefined): Promise<boolean> {
    if (!user?.id) return false;
    const row = await this.prisma.user.findUnique({ where: { id: user.id }, select: { isGuest: true, status: true } });
    return !!row && !row.isGuest && row.status === 'active';
  }

  private reply(
    mode: CaptainReply['mode'],
    intent: CaptainReply['intent'],
    text: string,
    extra: Partial<Omit<CaptainReply, 'mode' | 'intent' | 'reply'>> = {},
  ): CaptainReply {
    return {
      mode,
      intent,
      reply: text,
      venues: [],
      bookings: [],
      cta: null as CaptainCta | null,
      suggestions: [],
      context: null,
      needsLocation: false,
      relaxed: [],
      needsChallenge: false,
      logId: null,
      ...extra,
    };
  }
}

interface Base {
  lang: 'ar' | 'en';
  t: (ar: string, en: string) => string;
  catalog: CatalogNames;
  loggedIn: boolean;
  hasCoords: boolean;
  coords: { lat: number; lng: number } | null;
  knowledge: KnowledgeEntry[];
  trace: Trace;
}

function currencyAr(code: string): string {
  return currencyLabel(code, 'ar', true);
}

function relaxedWords(relaxed: CaptainReply['relaxed'], lang: 'ar' | 'en'): string {
  const map = {
    price: ['السعر', 'the price limit'],
    rating: ['التقييم', 'the rating filter'],
    instant: ['الحجز الفوري', 'instant booking'],
    district: ['المنطقة', 'the area'],
  } as const;
  const words = relaxed.map((r) => map[r][lang === 'ar' ? 0 : 1]);
  return words.join(lang === 'ar' ? ' و' : ' and ');
}
