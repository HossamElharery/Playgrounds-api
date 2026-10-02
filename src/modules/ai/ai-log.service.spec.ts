import { AiLogService } from './ai-log.service';
import { AiQuotaService } from './ai-quota.service';
import { AiUsageService } from './ai-usage.service';
import { AiCounterStore } from './ai-counter.store';

function build() {
  const prisma = {
    aiQuestionLog: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    aiOwnerEventLog: { create: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    aiCounterDaily: { deleteMany: jest.fn().mockResolvedValue({ count: 5 }) },
    aiCallDaily: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const counters = new AiCounterStore();
  const quota = new AiQuotaService(counters, { get: (k: string) => (k === 'AI_HASH_SALT' ? 'salt' : undefined) } as never);
  const usage = new AiUsageService({ get: () => undefined } as never, undefined, undefined, counters);
  const settings = { number: jest.fn().mockReturnValue(45) };
  const logs = new AiLogService(prisma as never, quota, usage, settings as never);
  return { logs, prisma, usage, counters, quota };
}

describe('AiLogService', () => {
  describe('player questions', () => {
    it('stores the sentence redacted, and an asker reference instead of an address or device id', () => {
      const { logs, prisma } = build();
      const id = logs.logQuestion({
        userKind: 'guest',
        text: 'كلمني 01012345678 او ابعتلي على a.b@mail.com',
        outcome: 'answered_fact',
        factIds: ['support_contact'],
        model: 'google/gemini-3.8-flash',
        ms: 800,
        costUsd: 0.0015,
        askerKey: 'ip:41.130.9.77',
      });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const data = prisma.aiQuestionLog.create.mock.calls[0][0].data;
      expect(data.id).toBe(id);
      expect(data.textRedacted).toBe('كلمني [number] او ابعتلي على [email]');
      expect(data.askerRef).toMatch(/^[0-9a-f]{12}$/);
      expect(data.costMicros).toBe(1500);
      expect(JSON.stringify(data)).not.toContain('41.130.9.77');
      expect(JSON.stringify(data)).not.toContain('01012345678');
    });

    it('stores a free-text reason as a harmless code, never as words', () => {
      const { logs, prisma } = build();
      logs.logQuestion({ userKind: 'guest', text: 'x y', outcome: 'limited', detail: 'Day Limit! Call 0101…' });
      expect(prisma.aiQuestionLog.create.mock.calls[0][0].data.detail).toBe('daylimitcall0101');
    });

    it('counts a flood of refusals but stores one row a minute per visitor and reason', () => {
      const { logs, prisma, usage } = build();
      for (let i = 0; i < 20; i++) logs.logQuestion({ userKind: 'guest', text: 'بادل', outcome: 'limited', detail: 'minute', askerKey: 'dev:abc12345' });
      expect(prisma.aiQuestionLog.create).toHaveBeenCalledTimes(1);
      expect(usage.statToday('limited:minute:guest')).toBe(20);
      logs.logQuestion({ userKind: 'guest', text: 'بادل', outcome: 'limited', detail: 'day', askerKey: 'dev:abc12345' });
      expect(prisma.aiQuestionLog.create).toHaveBeenCalledTimes(2);
    });

    it('counts a keyword fallback (no model answered) for the "assistant got dumber" indicator', () => {
      const { logs, usage } = build();
      logs.logQuestion({ userKind: 'player', text: 'بادل', outcome: 'venues', model: null });
      logs.logQuestion({ userKind: 'player', text: 'بادل', outcome: 'venues', model: 'm' });
      logs.logQuestion({ userKind: 'player', text: 'بادل', outcome: 'unavailable', model: null });
      expect(usage.statToday('keyword_fallback:public')).toBe(1);
    });

    it('never throws when the table is unwritable', async () => {
      const { logs, prisma } = build();
      prisma.aiQuestionLog.create.mockRejectedValue(new Error('db down'));
      expect(() => logs.logQuestion({ userKind: 'guest', text: 'بادل', outcome: 'venues' })).not.toThrow();
      await new Promise((r) => setImmediate(r));
    });
  });

  describe('feedback', () => {
    it('only rates a question this server handed out in the last day', async () => {
      const { logs, prisma } = build();
      expect(await logs.setFeedback('id-1', 'down')).toBe(true);
      const where = prisma.aiQuestionLog.updateMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ id: 'id-1', surface: 'captain' });
      expect(where.createdAt.gte.getTime()).toBeGreaterThan(Date.now() - 25 * 3600_000);
      prisma.aiQuestionLog.updateMany.mockResolvedValue({ count: 0 });
      expect(await logs.setFeedback('gone', 'up')).toBe(false);
    });
  });

  describe('owner events (no text, ever)', () => {
    it('stores intent, outcome, model, time and cost — and nothing a person typed', () => {
      const { logs, prisma } = build();
      logs.logOwnerEvent({ venueId: 'v1', userId: 'u1', event: 'ask', intent: 'book', outcome: 'planned', confidence: 0.9, model: 'google/gemini-3.8-flash', ms: 1200, costUsd: 0.002 });
      const data = prisma.aiOwnerEventLog.create.mock.calls[0][0].data;
      expect(Object.keys(data).sort()).toEqual(['confidence', 'costMicros', 'detail', 'event', 'intent', 'model', 'ms', 'outcome', 'userId', 'venueId']);
      expect(data.costMicros).toBe(2000);
    });

    it('turns even a careless "detail" into a code, so a customer name cannot slip in', () => {
      const { logs, prisma } = build();
      logs.logOwnerEvent({ event: 'applied', outcome: 'failed', detail: 'Failed for Mohamed 0101 Ahmed' });
      const detail = prisma.aiOwnerEventLog.create.mock.calls[0][0].data.detail as string;
      expect(detail).toMatch(/^[a-z0-9_.:-]*$/);
      expect(detail).not.toMatch(/\s/);
    });
  });

  describe('retention', () => {
    it('deletes player questions after the admin-set window and the rest after theirs', async () => {
      const { logs, prisma } = build();
      const out = await logs.purge();
      expect(out).toEqual({ questions: 3, ownerEvents: 1, counters: 5, calls: 0 });
      const cutoff = prisma.aiQuestionLog.deleteMany.mock.calls[0][0].where.createdAt.lt as Date;
      const days = (Date.now() - cutoff.getTime()) / 86_400_000;
      expect(days).toBeGreaterThan(44.9);
      expect(days).toBeLessThan(45.1);
    });
  });
});
