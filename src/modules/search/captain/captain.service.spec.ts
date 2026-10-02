import { ConfigService } from '@nestjs/config';
import { CaptainService } from './captain.service';
import { AiQuotaService } from '../../ai/ai-quota.service';
import { AiUsageService } from '../../ai/ai-usage.service';
import type { CaptainReading } from './captain.types';
import { EMPTY_FILTERS } from './captain-text';

const catalog = {
  sports: [
    { slug: 'padel', nameAr: 'بادل', nameEn: 'Padel' },
    { slug: 'football', nameAr: 'كورة', nameEn: 'Football' },
  ],
  districts: [{ slug: 'maadi', nameAr: 'المعادي', nameEn: 'Maadi' }],
};

const reading = (over: Partial<CaptainReading>): CaptainReading => ({
  ...EMPTY_FILTERS,
  intent: 'find_venues',
  followUp: false,
  topic: '',
  factIds: [],
  reply: '',
  question: '',
  confidence: 0.9,
  ...over,
});

const card = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  nameAr: `ملعب ${slug}`,
  nameEn: `Venue ${slug}`,
  ratingAvg: 4.6,
  ratingCount: 10,
  instantBook: true,
  hasOffers: false,
  photo: null,
  priceFrom: { amount: 300, currency: 'EGP' },
  district: { nameAr: 'المعادي', nameEn: 'Maadi' },
  ...over,
});

function build(opts: { read?: CaptainReading | null; results?: unknown[][]; faq?: unknown[]; bookings?: unknown[]; user?: Record<string, unknown> | null; env?: Record<string, string>; services?: Record<string, unknown> } = {}) {
  const searchExplore = jest.fn();
  for (const r of opts.results ?? [[card('a')]]) {
    searchExplore.mockResolvedValueOnce({ count: r.length, cards: { items: r } });
  }
  searchExplore.mockResolvedValue({ count: 0, cards: { items: [] } });
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(opts.user === undefined ? { isGuest: false, status: 'active' } : opts.user) },
    faqEntry: { findMany: jest.fn().mockResolvedValue(opts.faq ?? []) },
    booking: { findMany: jest.fn().mockResolvedValue(opts.bookings ?? []) },
  };
  const nlu = { read: jest.fn().mockResolvedValue(opts.read === undefined ? reading({}) : opts.read) };
  const aiContext = { listCatalog: jest.fn().mockResolvedValue(catalog) };
  const config = { get: (k: string) => (opts.env ?? {})[k] ?? '' } as unknown as ConfigService;
  const usage = new AiUsageService(config);
  const quota = new AiQuotaService();
  const sv = opts.services ?? {};
  const service = new CaptainService(prisma as never, nlu as never, aiContext as never, { searchExplore } as never, config, quota, usage, sv['knowledge'] as never, sv['settings'] as never, sv['logs'] as never, sv['turnstile'] as never);
  return { service, searchExplore, prisma, nlu, quota, usage };
}

const user = { id: 'u1', roles: ['player'] } as never;
const dto = (text: string, extra: Record<string, unknown> = {}) => ({ text, lang: 'ar' as const, ...extra });

describe('Captain', () => {
  it('answers a search from real venues, in words composed here, and never auto-navigates', async () => {
    const { service, searchExplore } = build({ read: reading({ sport: 'padel', district: 'maadi' }) });
    const res = await service.ask(dto('بادل في المعادي'), user);
    expect(res.mode).toBe('venues');
    expect(res.venues.map((v) => v.slug)).toEqual(['a']);
    expect(res.reply).toContain('ملعب a');
    expect(res.reply).toContain('300 جنيه');
    expect(searchExplore.mock.calls[0][0]).toMatchObject({ sport: 'padel', district: 'maadi', sort: 'rating' });
  });

  it('ranks "cheap" by price instead of pretending it is a ceiling', async () => {
    const { service, searchExplore } = build({ read: reading({ sport: 'padel', cheap: true }) });
    await service.ask(dto('بادل رخيص'), user);
    const q = searchExplore.mock.calls[0][0];
    expect(q.sort).toBe('price');
    expect(q.priceMax).toBeUndefined();
  });

  it('passes a stated ceiling in whole EGP', async () => {
    const { service, searchExplore } = build({ read: reading({ priceMax: 250 }) });
    await service.ask(dto('تحت 250'), user);
    expect(searchExplore.mock.calls[0][0].priceMax).toBe(250);
  });

  it('loosens the strict filters when nothing matches, and says so', async () => {
    const { service, searchExplore } = build({
      read: reading({ sport: 'padel', priceMax: 100 }),
      results: [[], [card('b')]],
    });
    const res = await service.ask(dto('بادل تحت 100'), user);
    expect(searchExplore).toHaveBeenCalledTimes(2);
    expect(res.relaxed).toEqual(['price']);
    expect(res.reply).toContain('خففت');
  });

  it('falls back to nearby areas when the asked area is empty', async () => {
    const { service } = build({
      read: reading({ sport: 'padel', district: 'maadi' }),
      results: [[], [card('c')]],
    });
    const res = await service.ask(dto('بادل في المعادي'), user);
    expect(res.relaxed).toContain('district');
    expect(res.venues).toHaveLength(1);
  });

  it('asks for the location instead of guessing when "near me" arrives without coordinates', async () => {
    const { service } = build({ read: reading({ nearMe: true, sport: 'padel' }) });
    const res = await service.ask(dto('بادل قريب'), user);
    expect(res.needsLocation).toBe(true);
  });

  it('builds a follow-up on the previous search, and starts over when it is a new request', async () => {
    const ctx = { ...EMPTY_FILTERS, sport: 'padel', district: 'maadi' };
    const follow = build({ read: reading({ followUp: true, cheap: true }) });
    await follow.service.ask(dto('أرخص من كده', { context: ctx }), user);
    expect(follow.searchExplore.mock.calls[0][0]).toMatchObject({ sport: 'padel', district: 'maadi', sort: 'price' });
    const fresh = build({ read: reading({ followUp: false, sport: 'football' }) });
    await fresh.service.ask(dto('كورة', { context: ctx }), user);
    expect(fresh.searchExplore.mock.calls[0][0].district).toBeUndefined();
  });

  it('ignores invented filters echoed back by the client', async () => {
    const { service, nlu } = build({ read: reading({}) });
    await service.ask(dto('x1', { context: { sport: 'made-up', district: '../etc', priceMax: -5, sort: 'drop' } }), user);
    expect(nlu.read.mock.calls[0][0].context).toMatchObject({ sport: null, district: null, priceMax: null, sort: null });
  });

  it('keeps searching with keyword matching when no model is reachable', async () => {
    const { service, searchExplore } = build({ read: null });
    const res = await service.ask(dto('عايز بادل في المعادي'), user);
    expect(res.mode).toBe('venues');
    expect(searchExplore.mock.calls[0][0]).toMatchObject({ sport: 'padel', district: 'maadi' });
  });

  it("shows the player's own upcoming bookings", async () => {
    const { service, prisma } = build({
      read: reading({ intent: 'my_bookings' }),
      bookings: [
        {
          id: 'b1',
          code: 'M-1',
          status: 'confirmed',
          slotStart: new Date(Date.now() + 86_400_000),
          venue: { slug: 'v', nameAr: 'نيون', nameEn: 'Neon' },
          court: { name: 'PS5 1' },
        },
      ],
    });
    const res = await service.ask(dto('حجوزاتي'), user);
    expect(res.mode).toBe('bookings');
    expect(prisma.booking.findMany.mock.calls[0][0].where.userId).toBe('u1');
    expect(res.reply).toContain('نيون');
  });

  it('sends a guest to sign in rather than showing anyone’s bookings', async () => {
    const { service, prisma } = build({ read: reading({ intent: 'my_bookings' }), user: { isGuest: true, status: 'active' } });
    const res = await service.ask(dto('حجوزاتي'), user);
    expect(res.cta?.kind).toBe('login');
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    const anon = build({ read: reading({ intent: 'my_bookings' }) });
    expect((await anon.service.ask(dto('حجوزاتي'), undefined)).cta?.kind).toBe('login');
  });

  it('answers a platform question with the real FAQ text, not the model’s words', async () => {
    const { service } = build({
      read: reading({ intent: 'faq', topic: 'الغاء حجز', reply: 'ممكن تلغي في أي وقت ببلاش!' }),
      faq: [
        {
          id: 'f1',
          questionAr: 'ازاي الغي الحجز؟',
          questionEn: 'How do I cancel?',
          answerAr: 'الإلغاء قبل الميعاد بـ 24 ساعة.',
          answerEn: 'Cancel 24h ahead.',
          ctaPath: 'app/bookings',
          ctaLabelAr: 'حجوزاتي',
          ctaLabelEn: 'My bookings',
        },
      ],
    });
    const res = await service.ask(dto('ازاي الغي الحجز'), user);
    expect(res.reply).toBe('الإلغاء قبل الميعاد بـ 24 ساعة.');
    expect(res.cta).toEqual({ kind: 'path', target: 'app/bookings', label: 'حجوزاتي' });
  });

  it('says it has no confirmed answer instead of making one up', async () => {
    const { service } = build({ read: reading({ intent: 'faq', topic: 'حاجة غريبة' }), faq: [] });
    const res = await service.ask(dto('حاجة غريبة'), user);
    expect(res.reply).toContain('مش لاقي إجابة مؤكدة');
    expect(res.cta?.kind).toBe('help');
  });

  it('asks a guest to sign in for features that need an account', async () => {
    const { service } = build({ read: reading({ intent: 'players' }), user: null });
    const res = await service.ask(dto('عايز أصحاب'), undefined);
    expect(res.cta?.kind).toBe('login');
  });

  it('turns an unclear sentence into one short question, never a canned menu of examples', async () => {
    const { service } = build({ read: reading({ intent: 'unknown', question: 'تقصد أنهي رياضة؟' }) });
    const res = await service.ask(dto('ممم'), user);
    expect(res.mode).toBe('clarify');
    expect(res.reply).toBe('تقصد أنهي رياضة؟');
  });

  it('degrades to a polite message when something throws', async () => {
    const { service, searchExplore } = build({ read: reading({}) });
    searchExplore.mockReset();
    searchExplore.mockRejectedValue(new Error('db'));
    const res = await service.ask(dto('بادل'), user);
    expect(res.mode).toBe('unavailable');
  });

  describe('knowledge (facts shown word for word)', () => {
    it('answers a lobby question with the written fact, never the model’s own words', async () => {
      const { service } = build({ read: reading({ intent: 'faq', factIds: ['invite_lobby'], reply: 'ابعت لأي حد!' }) });
      const res = await service.ask(dto('إزاي أعزم أصحابي على اللوبي'), user);
      expect(res.reply).toContain('ابعت لأصحابك');
      expect(res.reply).toContain('7');
      expect(res.reply).not.toContain('ابعت لأي حد');
    });

    it('ignores an id the model made up and falls back to the help center', async () => {
      const { service } = build({ read: reading({ intent: 'faq', factIds: ['totally_made_up'] }), faq: [] });
      const res = await service.ask(dto('سؤال غريب جدا'), user);
      expect(res.reply).toContain('مش لاقي إجابة مؤكدة');
    });

    it('does not promise a lobby feature that is switched off in this deployment', async () => {
      const off = build({ read: reading({ intent: 'faq', factIds: ['lobby_morphs'] }), faq: [] });
      expect((await off.service.ask(dto('إيه الأشكال في اللوبي'), user)).reply).toContain('مش لاقي إجابة مؤكدة');
      const on = build({ read: reading({ intent: 'faq', factIds: ['lobby_morphs'] }), env: { LOBBY_MORPHS_ENABLED: 'true' } });
      expect((await on.service.ask(dto('إيه الأشكال في اللوبي'), user)).reply).toContain('غيّر');
      expect(on.nlu.read.mock.calls[0][0].knowledge.map((k: { id: string }) => k.id)).toContain('lobby_morphs');
      expect(off.nlu.read.mock.calls[0][0].knowledge.map((k: { id: string }) => k.id)).not.toContain('lobby_morphs');
    });

    it('the ball needs movement, like the lobby itself', async () => {
      const ballOnly = build({ read: reading({}), env: { LOBBY_BALL_ENABLED: 'true' } });
      await ballOnly.service.ask(dto('x1'), user);
      expect(ballOnly.nlu.read.mock.calls[0][0].knowledge.map((k: { id: string }) => k.id)).not.toContain('lobby_ball');
    });

    it('turns a sign-in button into the right destination', async () => {
      const { service } = build({ read: reading({ intent: 'faq', factIds: ['account_needed'] }) });
      const res = await service.ask(dto('محتاج حساب؟'), undefined);
      expect(res.cta).toMatchObject({ kind: 'login' });
    });
  });

  describe('limits and abuse', () => {
    it('refuses nonsense without asking the model or counting it', async () => {
      const { service, nlu } = build();
      for (const text of ['??!!', 'aaaaaaaaaaaaaa', '12345678']) {
        const res = await service.ask(dto(text), undefined, '1.1.1.1');
        expect(res.mode).toBe('clarify');
      }
      expect(nlu.read).not.toHaveBeenCalled();
    });

    it('stops a visitor at the daily limit and sends them to sign in', async () => {
      const { service, nlu } = build({ env: { CAPTAIN_GUEST_PER_DAY: '3', CAPTAIN_GUEST_PER_MINUTE: '50', CAPTAIN_GUEST_IP_PER_MINUTE: '50' } });
      for (let i = 0; i < 3; i++) {
        expect((await service.ask(dto(`بادل في المعادي ${i}`, { deviceId: 'device-abcdef' }), undefined, '2.2.2.2')).mode).not.toBe('limited');
      }
      const res = await service.ask(dto('بادل تاني', { deviceId: 'device-abcdef' }), undefined, '2.2.2.2');
      expect(res.mode).toBe('limited');
      expect(res.cta?.kind).toBe('login');
      expect(nlu.read).toHaveBeenCalledTimes(3);
    });

    it('a new device id from the same address does not escape the address limit', async () => {
      const { service } = build({ env: { CAPTAIN_GUEST_PER_DAY: '1', CAPTAIN_GUEST_IP_PER_DAY: '2', CAPTAIN_GUEST_IP_PER_MINUTE: '50', CAPTAIN_GUEST_PER_MINUTE: '50' } });
      await service.ask(dto('بادل واحد', { deviceId: 'device-aaaaaa' }), undefined, '3.3.3.3');
      await service.ask(dto('بادل اتنين', { deviceId: 'device-bbbbbb' }), undefined, '3.3.3.3');
      const res = await service.ask(dto('بادل تلاتة', { deviceId: 'device-cccccc' }), undefined, '3.3.3.3');
      expect(res.mode).toBe('limited');
    });

    it('gives a signed-in player far more room than a visitor', async () => {
      const { service } = build({ env: { CAPTAIN_GUEST_PER_DAY: '1', CAPTAIN_USER_PER_MINUTE: '100' } });
      for (let i = 0; i < 20; i++) {
        expect((await service.ask(dto(`بادل في المعادي ${i}`), user, '4.4.4.4')).mode).not.toBe('limited');
      }
    });

    it('slows visitors down first when the day’s public budget runs low', async () => {
      const { service, usage } = build({ env: { CAPTAIN_GUEST_PER_DAY: '9', AI_PUBLIC_DAILY_BUDGET_USD: '1', CAPTAIN_GUEST_PER_MINUTE: '50', CAPTAIN_GUEST_IP_PER_MINUTE: '50' } });
      usage.record({ profile: 'public', provider: 'openrouter', model: 'm', ok: true, ms: 1, costUsd: 0.8 });
      for (let i = 0; i < 3; i++) await service.ask(dto(`بادل في المعادي ${i}`, { deviceId: 'device-pressure' }), undefined, '5.5.5.5');
      expect((await service.ask(dto('بادل رابعة', { deviceId: 'device-pressure' }), undefined, '5.5.5.5')).mode).toBe('limited');
    });

    it('asks a repeater to say something new instead of paying for the same message again', async () => {
      const { service, nlu } = build();
      const history = [
        { from: 'player', text: 'بادل' },
        { from: 'captain', text: 'تمام' },
        { from: 'player', text: 'بادل' },
      ];
      const res = await service.ask(dto('بادل', { history }), user);
      expect(res.mode).toBe('clarify');
      expect(nlu.read).not.toHaveBeenCalled();
    });
  });

  describe('the admin log', () => {
    const logs = () => ({ logQuestion: jest.fn().mockReturnValue('log-id-1') });

    it('records what was asked, what answered it and what it cost, and hands the id back for feedback', async () => {
      const l = logs();
      const { service } = build({
        read: { ...reading({ sport: 'padel' }), meta: { model: 'google/gemini-3.8-flash', ms: 900, costUsd: 0.0015 } },
        services: { logs: l },
      });
      const res = await service.ask(dto('بادل في المعادي', { deviceId: 'device-log-1' }), undefined, '8.8.8.8');
      expect(res.logId).toBe('log-id-1');
      expect(l.logQuestion).toHaveBeenCalledTimes(1);
      expect(l.logQuestion.mock.calls[0][0]).toMatchObject({
        userKind: 'guest',
        outcome: 'venues',
        intent: 'find_venues',
        model: 'google/gemini-3.8-flash',
        ms: 900,
        costUsd: 0.0015,
        askerKey: 'dev:device-log-1',
      });
    });

    it('logs a platform answer with the knowledge ids that answered it', async () => {
      const l = logs();
      const { service } = build({ read: reading({ intent: 'faq', factIds: ['cancel_policy'] }), services: { logs: l } });
      await service.ask(dto('ازاي الغي الحجز'), user);
      expect(l.logQuestion.mock.calls[0][0]).toMatchObject({ outcome: 'answered_fact', factIds: ['cancel_policy'], userKind: 'player' });
    });

    it('logs a question nothing could answer as unanswered, so it reaches the admin inbox', async () => {
      const l = logs();
      const { service } = build({ read: reading({ intent: 'faq', topic: 'تطبيق اندرويد' }), faq: [], services: { logs: l } });
      await service.ask(dto('عندكم تطبيق اندرويد'), user);
      expect(l.logQuestion.mock.calls[0][0]).toMatchObject({ outcome: 'unanswered', intent: 'faq' });
    });

    it('logs refusals with their reason', async () => {
      const l = logs();
      const { service } = build({ env: { CAPTAIN_GUEST_PER_DAY: '1', CAPTAIN_GUEST_PER_MINUTE: '50', CAPTAIN_GUEST_IP_PER_MINUTE: '50' }, services: { logs: l } });
      await service.ask(dto('بادل في المعادي', { deviceId: 'device-refuse-1' }), undefined, '9.9.9.9');
      await service.ask(dto('بادل تاني', { deviceId: 'device-refuse-1' }), undefined, '9.9.9.9');
      await service.ask(dto('??!!'), undefined, '9.9.9.9');
      const outcomes = l.logQuestion.mock.calls.map((c) => [c[0].outcome, c[0].detail]);
      expect(outcomes).toEqual([['venues', undefined], ['limited', 'day'], ['blocked', 'noise']]);
    });

    it('a failed log never fails the answer', async () => {
      const l = { logQuestion: jest.fn().mockImplementation(() => { throw new Error('db down'); }) };
      const { service } = build({ services: { logs: l } });
      const res = await service.ask(dto('بادل'), user);
      expect(res.mode).toBe('venues');
      expect(res.logId).toBeNull();
    });
  });

  describe('visitors switched off from the admin', () => {
    it('sends a visitor to sign in without asking any model, but never blocks a signed-in player', async () => {
      const settings = { flag: jest.fn().mockReturnValue(false), number: jest.fn().mockReturnValue(null) };
      const l = { logQuestion: jest.fn().mockReturnValue(null) };
      const { service, nlu } = build({ services: { settings, logs: l } });
      const visitor = await service.ask(dto('بادل في المعادي', { deviceId: 'device-off-1' }), undefined, '7.7.7.7');
      expect(visitor.mode).toBe('limited');
      expect(visitor.cta?.kind).toBe('login');
      expect(nlu.read).not.toHaveBeenCalled();
      expect(l.logQuestion.mock.calls[0][0]).toMatchObject({ outcome: 'limited', detail: 'guests_off' });
      const player = await service.ask(dto('بادل في المعادي'), user, '7.7.7.7');
      expect(player.mode).toBe('venues');
    });

    it('uses the admin-set limits over the environment', async () => {
      const settings = {
        flag: jest.fn().mockReturnValue(true),
        number: jest.fn().mockImplementation((k: string) => ({ captainGuestPerDay: 1, captainGuestPerMinute: 50, captainGuestIpPerMinute: 50 }[k] ?? null)),
      };
      const { service } = build({ env: { CAPTAIN_GUEST_PER_DAY: '50' }, services: { settings } });
      await service.ask(dto('بادل واحد', { deviceId: 'device-set-1' }), undefined, '6.6.6.6');
      expect((await service.ask(dto('بادل اتنين', { deviceId: 'device-set-1' }), undefined, '6.6.6.6')).mode).toBe('limited');
    });
  });

  describe('Turnstile', () => {
    const turnstile = (over: Record<string, unknown> = {}) => ({
      enabled: true,
      isVerified: jest.fn().mockReturnValue(false),
      markVerified: jest.fn(),
      suspicion: jest.fn().mockResolvedValue(null),
      verify: jest.fn().mockResolvedValue('ok'),
      ...over,
    });

    it('does nothing at all while it is not configured', async () => {
      const t = turnstile({ enabled: false });
      const { service } = build({ services: { turnstile: t } });
      const res = await service.ask(dto('بادل في المعادي', { deviceId: 'device-t-0' }), undefined, '1.2.3.4');
      expect(res.mode).toBe('venues');
      expect(t.suspicion).not.toHaveBeenCalled();
    });

    it('asks a suspicious visitor to prove they are human, before any quota or model is spent', async () => {
      const t = turnstile({ suspicion: jest.fn().mockResolvedValue('burst') });
      const l = { logQuestion: jest.fn().mockReturnValue(null) };
      const { service, nlu } = build({ services: { turnstile: t, logs: l } });
      const res = await service.ask(dto('بادل في المعادي', { deviceId: 'device-t-1' }), undefined, '1.2.3.4');
      expect(res.mode).toBe('challenge');
      expect(res.needsChallenge).toBe(true);
      expect(nlu.read).not.toHaveBeenCalled();
      expect(l.logQuestion.mock.calls[0][0]).toMatchObject({ outcome: 'blocked', detail: 'challenge_burst' });
    });

    it('answers normally once the visitor passes the check, and remembers them', async () => {
      const t = turnstile({ suspicion: jest.fn().mockResolvedValue('burst') });
      const { service } = build({ services: { turnstile: t } });
      const res = await service.ask(dto('بادل في المعادي', { deviceId: 'device-t-2', challengeToken: 'good-token' }), undefined, '1.2.3.4');
      expect(t.verify).toHaveBeenCalledWith('good-token', '1.2.3.4');
      expect(t.markVerified).toHaveBeenCalled();
      expect(res.mode).toBe('venues');
    });

    it('asks again when the token is refused', async () => {
      const t = turnstile({ verify: jest.fn().mockResolvedValue('failed') });
      const { service } = build({ services: { turnstile: t } });
      const res = await service.ask(dto('بادل', { deviceId: 'device-t-3', challengeToken: 'bad' }), undefined, '1.2.3.4');
      expect(res.needsChallenge).toBe(true);
    });

    it('lets a visitor through, on a tighter allowance, when Cloudflare cannot be reached', async () => {
      const t = turnstile({ verify: jest.fn().mockResolvedValue('error') });
      const { service } = build({ env: { CAPTAIN_GUEST_PER_DAY: '9', CAPTAIN_GUEST_PER_MINUTE: '50', CAPTAIN_GUEST_IP_PER_MINUTE: '50' }, services: { turnstile: t } });
      const modes: string[] = [];
      for (let i = 0; i < 4; i++) modes.push((await service.ask(dto(`بادل ${i}`, { deviceId: 'device-t-4', challengeToken: 'tok' }), undefined, '1.2.3.5')).mode);
      expect(modes.slice(0, 3)).not.toContain('limited'); // 9 → 3 a day while the check is down
      expect(modes[3]).toBe('limited');
    });

    it('never challenges a signed-in player', async () => {
      const t = turnstile({ suspicion: jest.fn().mockResolvedValue('burst') });
      const { service } = build({ services: { turnstile: t } });
      const res = await service.ask(dto('بادل في المعادي'), user, '1.2.3.4');
      expect(res.mode).toBe('venues');
      expect(t.suspicion).not.toHaveBeenCalled();
    });
  });
});
