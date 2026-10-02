import { AiAdminOverviewService } from './ai-admin-overview.service';
import { dayDate, utcDayString, addDays } from '../ai-day';

const today = () => dayDate(utcDayString());
const callRow = (over: Record<string, unknown> = {}) => ({ day: today(), profile: 'public', provider: 'openrouter', model: 'google/gemini-3.8-flash', calls: 100, failures: 2, fallbackCalls: 0, costMicros: 150_000, totalMs: 100_000, ...over });

function build(opts: {
  rows?: unknown[];
  breakers?: unknown[];
  credit?: { key?: Record<string, unknown> | null; credits?: Record<string, unknown> | null };
  questionGroups?: { outcome: string; _count: { _all: number } }[];
  keywordToday?: number;
  budgets?: { owner: number; public: number };
} = {}) {
  const prisma = {
    aiCallDaily: { findMany: jest.fn().mockResolvedValue(opts.rows ?? [callRow()]) },
    aiCounterDaily: { findMany: jest.fn().mockResolvedValue([]) },
    aiQuestionLog: {
      groupBy: jest.fn().mockResolvedValue(opts.questionGroups ?? [{ outcome: 'venues', _count: { _all: 50 } }]),
      count: jest.fn().mockResolvedValue(opts.keywordToday ?? 0),
    },
    aiOwnerEventLog: { groupBy: jest.fn().mockResolvedValue([]) },
    auditLogEntry: { create: jest.fn().mockResolvedValue({}) },
  };
  const provider = {
    enabled: true,
    breakerStates: jest.fn().mockReturnValue(opts.breakers ?? []),
    chain: jest.fn().mockReturnValue([{ kind: 'openrouter', model: 'google/gemini-3.8-flash' }]),
  };
  const budgets = opts.budgets ?? { owner: 1.5, public: 1.5 };
  const usage = { flush: jest.fn(), budgetUsd: (p: 'owner' | 'public') => budgets[p], spentToday: jest.fn().mockReturnValue(0.15) };
  const counters = { flush: jest.fn() };
  const settingsState: Record<string, number | boolean> = {};
  const settings = {
    describe: jest.fn().mockImplementation(() => Object.entries(settingsState).map(([key, value]) => ({ key, value }))),
    update: jest.fn().mockImplementation(async (patch: Record<string, number | boolean | null>) => {
      for (const [k, v] of Object.entries(patch)) if (v === null) delete settingsState[k]; else settingsState[k] = v;
    }),
    number: jest.fn().mockReturnValue(null),
  };
  const config = { get: (k: string) => (k === 'OPENROUTER_API_KEY' ? 'key' : undefined) };
  const turnstile = { enabled: false };
  const service = new AiAdminOverviewService(prisma as never, config as never, provider as never, usage as never, counters as never, settings as never, turnstile as never);
  const original = global.fetch;
  global.fetch = jest.fn(async (url: string) => {
    const path = String(url).split('/api/v1/')[1];
    const body = path === 'key' ? opts.credit?.key : opts.credit?.credits;
    if (body === null || body === undefined) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: body }) };
  }) as never;
  return { service, prisma, settings, restore: () => (global.fetch = original) };
}

describe('AiAdminOverviewService', () => {
  describe('overview', () => {
    it('adds up spend per audience for today, the week and the month, and the share of each model', async () => {
      const rows = [
        callRow({ costMicros: 100_000 }),
        callRow({ day: dayDate(addDays(utcDayString(), -3)), costMicros: 200_000 }),
        callRow({ day: dayDate(addDays(utcDayString(), -20)), costMicros: 400_000 }),
        callRow({ profile: 'owner', model: 'google/gemini-3.6-flash', calls: 300, costMicros: 600_000 }),
      ];
      const { service, restore } = build({ rows });
      const o = await service.overview();
      expect(o.spend.public.today.spendUsd).toBeCloseTo(0.1, 4);
      expect(o.spend.public.week.spendUsd).toBeCloseTo(0.3, 4);
      expect(o.spend.public.month.spendUsd).toBeCloseTo(0.7, 4);
      expect(o.spend.owner.today.calls).toBe(300);
      const share = o.models.today.reduce((n, m) => n + m.share, 0);
      expect(share).toBeCloseTo(1, 2);
      expect(o.trend).toHaveLength(14);
      restore();
    });

    it('turns a model paused for lack of credit into a red alert that says to top up OpenRouter', async () => {
      const { service, restore } = build({ breakers: [{ id: 'openrouter:google/gemini-3.8-flash', kind: 'openrouter', model: 'google/gemini-3.8-flash', reason: 'credit', openUntil: Date.now() + 300_000 }] });
      const o = await service.overview();
      expect(o.alerts).toContainEqual({ level: 'danger', code: 'out_of_credit', model: 'google/gemini-3.8-flash' });
      expect(o.breakers[0]).toMatchObject({ reason: 'credit' });
      restore();
    });

    it('warns when the OpenRouter balance (account or key limit) is under 2 dollars, and shows both numbers', async () => {
      const { service, restore } = build({ credit: { key: { limit: 5, limit_remaining: 1.2 }, credits: { total_credits: 10, total_usage: 3 } } });
      const o = await service.overview();
      expect(o.credit).toMatchObject({ accountRemainingUsd: 7, keyRemainingUsd: 1.2, keyLimitUsd: 5, error: null });
      expect(o.alerts).toContainEqual({ level: 'warn', code: 'low_credit', value: 1.2 });
      restore();
    });

    it('does not raise a balance alert when there is plenty, and survives OpenRouter being unreachable', async () => {
      const ok = build({ credit: { key: { limit: null, limit_remaining: null }, credits: { total_credits: 10, total_usage: 2 } } });
      expect((await ok.service.overview()).alerts.map((a) => a.code)).not.toContain('low_credit');
      ok.restore();
      const down = build({ credit: { key: null, credits: null } });
      const o = await down.service.overview();
      expect(o.credit.error).toBe('unreachable');
      expect(o.alerts.map((a) => a.code)).not.toContain('low_credit');
      down.restore();
    });

    it('flags a budget that is nearly or fully spent', async () => {
      const { service, restore } = build({ rows: [callRow({ costMicros: 1_100_000 }), callRow({ profile: 'owner', costMicros: 1_600_000 })], budgets: { owner: 1.5, public: 1.5 } });
      const o = await service.overview();
      expect(o.alerts).toContainEqual({ level: 'warn', code: 'budget_high', profile: 'public', value: 73 });
      expect(o.alerts).toContainEqual({ level: 'danger', code: 'budget_exhausted', profile: 'owner' });
      restore();
    });

    it('shows how often the assistant fell back to plain keywords, and warns when that gets common', async () => {
      const { service, restore } = build({ questionGroups: [{ outcome: 'venues', _count: { _all: 40 } }, { outcome: 'limited', _count: { _all: 9 } }], keywordToday: 16 });
      const o = await service.overview();
      expect(o.fallbacks).toMatchObject({ askedToday: 40, keywordToday: 16, keywordRate: 0.4 });
      expect(o.alerts).toContainEqual({ level: 'warn', code: 'keyword_fallback_high', value: 40 });
      restore();
    });

    it('does not cry wolf on a quiet day', async () => {
      const { service, restore } = build({ rows: [], questionGroups: [{ outcome: 'venues', _count: { _all: 3 } }], keywordToday: 3 });
      expect((await service.overview()).alerts).toEqual([]);
      restore();
    });
  });

  describe('limits', () => {
    it('rejects bad values with a per-field reason and changes nothing', async () => {
      const { service, settings, restore } = build();
      await expect(service.updateLimits({ captainGuestPerDay: -5, nope: 1 }, 'admin1')).rejects.toMatchObject({ response: { code: 'VALIDATION_FAILED', result: { errors: expect.objectContaining({ captainGuestPerDay: expect.any(String), nope: 'unknown setting' }) } } });
      expect(settings.update).not.toHaveBeenCalled();
      await expect(service.updateLimits({}, 'admin1')).rejects.toBeDefined();
      restore();
    });

    it('saves valid values and leaves an audit entry with before and after', async () => {
      const { service, settings, prisma, restore } = build();
      await service.updateLimits({ captainGuestPerDay: 25 }, 'admin1');
      expect(settings.update).toHaveBeenCalledWith({ captainGuestPerDay: 25 }, 'admin1');
      const audit = prisma.auditLogEntry.create.mock.calls[0][0].data;
      expect(audit).toMatchObject({ actorUserId: 'admin1', action: 'ai.settings.update' });
      expect((audit.metadata as { changed: unknown[] }).changed).toEqual([{ key: 'captainGuestPerDay', from: null, to: 25 }]);
      restore();
    });
  });
});
