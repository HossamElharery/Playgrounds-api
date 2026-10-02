import { AssistantTranscriptService } from './assistant-transcript.service';

function build() {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    venue: { findUnique: jest.fn().mockResolvedValue({ nameAr: 'نيون', nameEn: 'Neon' }) },
    assistantTranscript: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return { service: new AssistantTranscriptService(prisma as never), prisma, created };
}

const turn = {
  ownerId: 'u1',
  ownerName: 'حسام',
  venueId: 'v1',
  ownerText: 'احجز بلايستيشن 1 بكرة لمحمد بـ 400',
  replyText: 'حجز محمد في PS5 Room 1 — السعر 400 جنيه.',
  intent: 'book',
  outcome: 'planned' as const,
  confidence: 0.9,
  model: 'google/gemini-3.8-flash',
};

describe('AssistantTranscriptService', () => {
  it('writes the owner’s sentence and the answer as a pair, owner first, with the names as they were', async () => {
    const { service, created } = build();
    await service.recordTurn({ ...turn, meta: { actions: [{ kind: 'create_booking' }] } });
    expect(created.map((c) => c['sender'])).toEqual(['owner', 'assistant']);
    expect(created[0]).toMatchObject({ ownerId: 'u1', ownerName: 'حسام', venueId: 'v1', venueName: 'نيون', text: turn.ownerText, source: 'server', intent: 'book' });
    expect(created[1]).toMatchObject({ text: turn.replyText, meta: { actions: [{ kind: 'create_booking' }] } });
    expect((created[1]['createdAt'] as Date).getTime()).toBeGreaterThan((created[0]['createdAt'] as Date).getTime());
  });

  it('flags what stands out, including a sentence repeated three times', async () => {
    const { service, prisma, created } = build();
    prisma.assistantTranscript.count.mockResolvedValue(2);
    await service.recordTurn({ ...turn, outcome: 'clarify', intent: 'unknown', ownerText: 'هههههههههههه' });
    expect(created[0]['flags']).toEqual(expect.arrayContaining(['unrecognized', 'noise', 'repeated']));
  });

  it('writes the owner line even when the assistant had nothing to say (AI down)', async () => {
    const { service, created } = build();
    await service.recordTurn({ ...turn, replyText: '', outcome: 'unavailable' });
    expect(created.map((c) => c['sender'])).toEqual(['owner']);
    expect(created[0]['flags']).toContain('unavailable');
  });

  it('never throws into the owner’s request when the database is down', async () => {
    const { service, prisma } = build();
    prisma.assistantTranscript.create.mockRejectedValue(new Error('db down'));
    await expect(service.recordTurn(turn)).resolves.toBeUndefined();
    await expect(service.recordEvent({ ownerId: 'u1', kind: 'action', text: 'x', outcome: 'applied' })).resolves.toBeUndefined();
    await expect(service.mirrorClientLine({ ownerId: 'u1', venueId: 'v1', sender: 'owner', text: 'x' })).resolves.toBeUndefined();
  });

  it('records what happened after Confirm and Undo, with the confirmed actions', async () => {
    const { service, created } = build();
    await service.recordEvent({ ownerId: 'u1', venueId: 'v1', kind: 'action', intent: 'create_booking', outcome: 'applied', text: 'اتسجل الحجز ✅', meta: { actions: [{ kind: 'create_booking' }] } });
    await service.recordEvent({ ownerId: 'u1', venueId: 'v1', kind: 'undo', outcome: 'failed', text: 'فشل' });
    expect(created[0]).toMatchObject({ kind: 'action', outcome: 'applied', sender: 'assistant', flags: [] });
    expect(created[1]).toMatchObject({ kind: 'undo', outcome: 'failed', flags: ['failed'] });
  });

  it('absorbs the app’s copy of a line the server already wrote, once', async () => {
    const { service, prisma, created } = build();
    prisma.assistantTranscript.findFirst.mockResolvedValueOnce({ id: 'server-row' });
    await service.mirrorClientLine({ ownerId: 'u1', venueId: 'v1', sender: 'owner', text: turn.ownerText });
    expect(prisma.assistantTranscript.update).toHaveBeenCalledWith({ where: { id: 'server-row' }, data: { clientCopy: true } });
    expect(created).toHaveLength(0);
    expect(prisma.assistantTranscript.findFirst.mock.calls[0][0].where).toMatchObject({ source: 'server', clientCopy: false });
  });

  it('keeps a line only the app knew about (a command it handled on its own)', async () => {
    const { service, created } = build();
    await service.mirrorClientLine({ ownerId: 'u1', venueId: 'v1', sender: 'assistant', text: 'قفلتلك الملعب', scheduleChange: true });
    expect(created[0]).toMatchObject({ source: 'client', kind: 'schedule', sender: 'assistant', venueName: 'نيون' });
  });

  it('pairs each request with the answer that followed it, for the same owner and venue', async () => {
    const { service, prisma } = build();
    const t = Date.parse('2026-10-02T10:00:00Z');
    prisma.assistantTranscript.count.mockResolvedValue(2);
    prisma.assistantTranscript.findMany
      .mockResolvedValueOnce([
        { id: 'a', createdAt: new Date(t), ownerId: 'u1', ownerName: 'حسام', venueId: 'v1', venueName: 'نيون', sender: 'owner', kind: 'chat', text: 'احجز', intent: null, outcome: 'clarify', confidence: null, model: null, flags: ['unrecognized'], meta: null, source: 'server' },
      ])
      .mockResolvedValueOnce([
        { id: 'b', ownerId: 'u1', venueId: 'v2', createdAt: new Date(t + 1), text: 'رد على منشأة تانية', kind: 'chat' },
        { id: 'c', ownerId: 'u1', venueId: 'v1', createdAt: new Date(t + 1), text: 'أي ملعب بالظبط؟', kind: 'chat' },
      ]);
    const out = await service.listTurns({ page: 1, perPage: 20 });
    expect(out.items[0]).toMatchObject({ text: 'احجز', reply: 'أي ملعب بالظبط؟', flags: ['unrecognized'] });
  });

  it('filters by flag, outcome, owner and free text across the sentence, owner and venue names', async () => {
    const { service, prisma } = build();
    await service.list({ q: 'نيون', flag: 'blocked', outcome: 'planned', ownerId: 'u1', notable: true, page: 1, perPage: 20 });
    const where = prisma.assistantTranscript.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ ownerId: 'u1', outcome: 'planned', flags: { has: 'blocked' } });
    expect(where.OR).toHaveLength(3);
  });
});
