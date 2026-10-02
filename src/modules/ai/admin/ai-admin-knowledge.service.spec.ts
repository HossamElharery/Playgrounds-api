import { AiAdminKnowledgeService } from './ai-admin-knowledge.service';

const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, topicAr: 'موضوع ' + id, topicEn: 'topic ' + id, ar: 'نص ' + id, en: 'text ' + id, ...extra });

function build(opts: { live?: ReturnType<typeof entry>[]; read?: unknown; ai?: unknown; faq?: unknown[] } = {}) {
  const live = opts.live ?? [entry('cancel_policy')];
  const prisma = { faqEntry: { findMany: jest.fn().mockResolvedValue(opts.faq ?? []) } };
  const provider = { getStructuredIntent: jest.fn().mockResolvedValue(opts.ai ?? { raw: '{}', model: 'm' }) };
  const knowledge = {
    entries: jest.fn().mockResolvedValue(live),
    forDeployment: jest.fn().mockImplementation((e: { when?: string }[]) => e.filter((x) => !x.when)),
  };
  const nlu = { read: jest.fn().mockResolvedValue(opts.read === undefined ? { intent: 'faq', topic: 't', factIds: ['cancel_policy'], meta: { model: 'm', ms: 5, costUsd: 0.001 } } : opts.read) };
  const service = new AiAdminKnowledgeService(prisma as never, provider as never, knowledge as never, nlu as never);
  return { service, prisma, provider, knowledge, nlu };
}

describe('AiAdminKnowledgeService.preview', () => {
  it('runs the real reading step against the live knowledge and shows what a player would see', async () => {
    const { service, nlu } = build();
    const out = await service.preview({ text: 'ازاي الغي الحجز' });
    expect(nlu.read.mock.calls[0][0]).toMatchObject({ skipBudget: true, loggedIn: true, knowledge: [expect.objectContaining({ id: 'cancel_policy' })] });
    expect(out).toMatchObject({ outcome: 'answered_fact', factIds: ['cancel_policy'], draftPicked: false, model: 'm' });
    expect(out.picked[0]).toMatchObject({ id: 'cancel_policy', ar: 'نص cancel_policy', en: 'text cancel_policy' });
  });

  it('swaps the unsaved draft into the list for this one call, and says whether the model chose it', async () => {
    const { service, nlu } = build({ read: { intent: 'faq', topic: '', factIds: ['android_app'], meta: { model: 'm', ms: 1, costUsd: 0 } } });
    const out = await service.preview({
      text: 'عندكم تطبيق اندرويد',
      draft: { id: 'android_app', topicAr: 'تطبيق الأندرويد', topicEn: 'Android app', ar: 'متاح على أندرويد.', en: 'Available on Android.' },
    });
    const sent = (nlu.read.mock.calls[0][0] as { knowledge: { id: string }[] }).knowledge.map((k) => k.id);
    expect(sent).toEqual(['cancel_policy', 'android_app']);
    expect(out.draftPicked).toBe(true);
    expect(out.picked[0].ar).toBe('متاح على أندرويد.');
  });

  it('replaces the saved version when the draft edits an existing entry', async () => {
    const { service, nlu } = build();
    await service.preview({ text: 'الغاء', draft: { id: 'cancel_policy', topicAr: 'سياسة جديدة للإلغاء', topicEn: 'New policy', ar: 'جديد', en: 'new' } });
    const sent = (nlu.read.mock.calls[0][0] as { knowledge: { id: string; ar: string }[] }).knowledge;
    expect(sent).toHaveLength(1);
    expect(sent[0].ar).toBe('جديد');
  });

  it('says so when a draft would be hidden from players by a feature flag', async () => {
    const { service } = build({ read: { intent: 'faq', topic: '', factIds: [], meta: { model: 'm', ms: 1, costUsd: 0 } } });
    const out = await service.preview({ text: 'الأشكال', draft: { id: 'morph_new', topicAr: 'الأشكال في اللوبي', topicEn: 'Morphs', ar: 'نص', en: 'text', flag: 'morphs' } });
    expect(out.draftHiddenByFlag).toBe(true);
  });

  it('reports "unanswered" when the model sees a platform question but nothing — not even the help center — answers it', async () => {
    const { service } = build({ read: { intent: 'faq', topic: 'تطبيق', factIds: [], meta: { model: 'm', ms: 1, costUsd: 0 } }, faq: [] });
    expect((await service.preview({ text: 'عندكم تطبيق' })).outcome).toBe('unanswered');
  });

  it('says when the sentence is not a platform question at all, or when no model answered', async () => {
    expect((await build({ read: { intent: 'find_venues', topic: '', factIds: [], meta: { model: 'm', ms: 1, costUsd: 0 } } }).service.preview({ text: 'بادل في المعادي' })).outcome).toBe('not_a_question');
    const none = await build({ read: null }).service.preview({ text: 'بادل في المعادي' });
    expect(none).toMatchObject({ modelAnswered: false, outcome: 'not_a_question' });
  });

  it('rejects an empty or oversized sentence', async () => {
    const { service } = build();
    await expect(service.preview({ text: ' ' })).rejects.toBeDefined();
    await expect(service.preview({ text: 'x'.repeat(301) })).rejects.toBeDefined();
  });
});

describe('AiAdminKnowledgeService.draft', () => {
  it('with only a question, proposes an id and topics and leaves the answers empty — the model supplies no facts', async () => {
    const { service, provider } = build({ ai: { raw: JSON.stringify({ id: 'Android App!', topicAr: 'تطبيق الأندرويد', topicEn: 'Android app', ar: 'اختراع المودل', en: 'invented by the model' }), model: 'g' } });
    const out = await service.draft({ question: 'عندكم تطبيق اندرويد؟' });
    expect(out).toMatchObject({ id: 'android_app', topicAr: 'تطبيق الأندرويد', topicEn: 'Android app', ar: '', en: '', note: 'topics_only', model: 'g' });
    expect(provider.getStructuredIntent.mock.calls[0][0]).toMatchObject({ profile: 'public', skipBudget: true });
  });

  it('keeps the language the admin wrote exactly as written and only takes the other from the model', async () => {
    const { service } = build({ ai: { raw: JSON.stringify({ id: 'android_app', topicAr: 'ت', topicEn: 'Android app', ar: 'نسخة المودل المعدلة', en: 'Available on Android.' }), model: 'g' } });
    const out = await service.draft({ question: 'x y', answerAr: 'متاح على أندرويد.' });
    expect(out).toMatchObject({ ar: 'متاح على أندرويد.', en: 'Available on Android.', note: 'translated' });
  });

  it('strips links from whatever the model returns', async () => {
    const { service } = build({ ai: { raw: JSON.stringify({ id: 'x_y', topicAr: 'موضوع https://evil.com', topicEn: 'topic', ar: '', en: 'see https://evil.com now' }), model: 'g' } });
    const out = await service.draft({ answerAr: 'نص' });
    expect(out.en).not.toContain('http');
    expect(out.topicAr).not.toContain('http');
  });

  it('needs something to work from, and reports when no model is reachable', async () => {
    await expect(build().service.draft({})).rejects.toBeDefined();
    const { AiUnavailableError } = jest.requireActual('../ai-provider.types');
    const { service, provider } = build();
    provider.getStructuredIntent.mockRejectedValue(new AiUnavailableError());
    await expect(service.draft({ question: 'سؤال' })).rejects.toMatchObject({ response: { code: 'AI_UNAVAILABLE' } });
  });
});
