import { AiAdminQuestionsService } from './ai-admin-questions.service';

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  createdAt: new Date('2026-10-02T10:00:00Z'),
  surface: 'captain',
  userKind: 'guest',
  textRedacted: 'عندكم تطبيق اندرويد',
  lang: 'ar',
  intent: 'faq',
  outcome: 'unanswered',
  detail: null,
  factIds: [],
  reading: null,
  model: 'm',
  ms: 100,
  costMicros: 1500,
  askerRef: 'abc',
  feedback: null,
  feedbackAt: null,
  status: 'new',
  resolvedNote: null,
  resolvedAt: null,
  resolvedById: null,
  resolvedKnowledgeId: null,
  verifiedOk: null,
  ...over,
});

function build(rows: ReturnType<typeof row>[], readFactIds: string[][] = [['android_app']]) {
  const prisma = {
    aiQuestionLog: {
      findMany: jest.fn().mockResolvedValue(rows),
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: rows.length }),
      count: jest.fn().mockResolvedValue(rows.length),
    },
    auditLogEntry: { create: jest.fn().mockResolvedValue({}) },
  };
  const knowledge = { forPlayers: jest.fn().mockResolvedValue([{ id: 'android_app' }]), invalidate: jest.fn() };
  let i = 0;
  const nlu = { read: jest.fn().mockImplementation(async () => ({ intent: 'faq', factIds: readFactIds[Math.min(i++, readFactIds.length - 1)] })) };
  const tools = { preview: jest.fn().mockResolvedValue({ outcome: 'answered_fact' }) };
  const service = new AiAdminQuestionsService(prisma as never, knowledge as never, nlu as never, tools as never);
  return { service, prisma, knowledge, nlu, tools };
}

describe('AiAdminQuestionsService', () => {
  it('shows an inbox of unanswered and thumbs-down questions grouped by topic, biggest first, with the redacted text only', async () => {
    const { service } = build([
      row('1', { textRedacted: 'المايك مش شغال في اللوبي' }),
      row('2', { textRedacted: 'المايك مبيشتغلش في اللوبي ليه', outcome: 'answered_fact', feedback: 'down' }),
      row('3', { textRedacted: 'عندكم تطبيق اندرويد' }),
    ]);
    const inbox = await service.inbox();
    expect(inbox.clusters.map((c) => c.size)).toEqual([2, 1]);
    expect(inbox.clusters[0]).toMatchObject({ unanswered: 1, down: 1 });
    expect(inbox.clusters[0].ids.sort()).toEqual(['1', '2']);
  });

  it('only ever asks the database for open questions that were unanswered or marked 👎', async () => {
    const { service, prisma } = build([row('1')]);
    await service.inbox();
    const where = prisma.aiQuestionLog.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['new', 'reviewed'] });
    expect(where.OR).toEqual([{ outcome: 'unanswered' }, { feedback: 'down' }]);
  });

  it('resolves a whole cluster with the entry that answers it, and proves the entry is now chosen', async () => {
    const { service, prisma, knowledge, nlu } = build([row('1'), row('2', { textRedacted: 'هل فيه تطبيق اندرويد' })]);
    const out = await service.resolve('1', { knowledgeId: 'android_app', ids: ['2'] }, 'admin1');
    expect(out.resolved).toBe(2);
    expect(prisma.aiQuestionLog.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'resolved', resolvedKnowledgeId: 'android_app', resolvedById: 'admin1' });
    expect(knowledge.invalidate).toHaveBeenCalled();
    expect(nlu.read).toHaveBeenCalledTimes(2);
    expect(nlu.read.mock.calls[0][0]).toMatchObject({ skipBudget: true, text: 'عندكم تطبيق اندرويد' });
    expect(out.verification).toMatchObject({ ok: true, passed: 2, total: 2 });
    expect(prisma.aiQuestionLog.updateMany.mock.calls[1][0].data).toEqual({ verifiedOk: true });
    expect(prisma.auditLogEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'ai.question.resolve', actorUserId: 'admin1' }) });
  });

  it('still resolves, but reports a failed test, when the model does not choose the new entry', async () => {
    const { service, prisma } = build([row('1')], [['cancel_policy']]);
    const out = await service.resolve('1', { knowledgeId: 'android_app' }, 'admin1');
    expect(out.verification).toMatchObject({ ok: false, passed: 0, total: 1 });
    expect(prisma.aiQuestionLog.updateMany.mock.calls[1][0].data).toEqual({ verifiedOk: false });
  });

  it('does not run a test when there is no entry to test, or when asked not to', async () => {
    const a = build([row('1')]);
    expect((await a.service.resolve('1', {}, 'admin1')).verification).toBeNull();
    const b = build([row('1')]);
    expect((await b.service.resolve('1', { knowledgeId: 'android_app', verify: false }, 'admin1')).verification).toBeNull();
    expect(a.nlu.read).not.toHaveBeenCalled();
    expect(b.nlu.read).not.toHaveBeenCalled();
  });

  it('tests at most three different phrasings of a cluster', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(String(i + 1), { textRedacted: `سؤال مختلف رقم ${i}` }));
    const { service, nlu } = build(rows);
    await service.resolve('1', { knowledgeId: 'android_app', ids: ['2', '3', '4', '5', '6'] }, 'admin1');
    expect(nlu.read).toHaveBeenCalledTimes(3);
  });

  it('marks a cluster ignored or reviewed in one call, and refuses an empty list', async () => {
    const { service, prisma } = build([row('1')]);
    await service.setStatus(['1', '2', '2'], 'ignored', undefined, 'admin1');
    expect(prisma.aiQuestionLog.updateMany.mock.calls[0][0].where).toEqual({ id: { in: ['1', '2'] } });
    await expect(service.setStatus([], 'ignored', undefined, 'admin1')).rejects.toBeDefined();
  });

  it('re-asks a logged question against the live knowledge', async () => {
    const { service, tools } = build([row('1', { userKind: 'player' })]);
    await service.retest('1');
    expect(tools.preview).toHaveBeenCalledWith({ text: 'عندكم تطبيق اندرويد', lang: 'ar', loggedIn: true });
    await expect(service.retest('missing')).rejects.toBeDefined();
  });

  it('filters the list by outcome, language, who asked, feedback and text, and pages it', async () => {
    const { service, prisma } = build([row('1')]);
    await service.list({ outcome: 'unanswered', lang: 'ar', userKind: 'guest', feedback: 'down', q: 'اندرويد', page: 2, perPage: 20 });
    expect(prisma.aiQuestionLog.findMany.mock.calls[0][0]).toMatchObject({
      where: { outcome: 'unanswered', lang: 'ar', userKind: 'guest', feedback: 'down', textRedacted: { contains: 'اندرويد', mode: 'insensitive' } },
      skip: 20,
      take: 20,
    });
  });

  it('lists what owners asked their assistant, as typed, with the venue and who asked', async () => {
    const { service, prisma } = build([row('1')]);
    const p = prisma as unknown as Record<string, unknown>;
    p['aiOwnerEventLog'] = {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([{ id: 'e1', createdAt: new Date('2026-10-02T10:00:00Z'), venueId: 'v1', userId: 'u1', text: 'احجز لمحمد 01012345678', intent: 'book', outcome: 'planned', detail: null, confidence: 0.9, model: 'm', ms: 900, costMicros: 2000 }]),
    };
    p['venue'] = { findMany: jest.fn().mockResolvedValue([{ id: 'v1', nameAr: 'نيون', nameEn: 'Neon' }]) };
    p['user'] = { findMany: jest.fn().mockResolvedValue([{ id: 'u1', name: 'أحمد' }]) };
    const out = await service.ownerRequests({ q: 'محمد', outcome: 'planned', page: 1, perPage: 20 });
    expect((p['aiOwnerEventLog'] as { findMany: jest.Mock }).findMany.mock.calls[0][0].where).toMatchObject({ event: 'ask', outcome: 'planned', text: { contains: 'محمد', mode: 'insensitive' } });
    expect(out.items[0]).toMatchObject({ text: 'احجز لمحمد 01012345678', venueName: 'نيون', userName: 'أحمد', costUsd: 0.002 });
  });
});
