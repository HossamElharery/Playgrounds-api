import { AiUsageService } from './ai-usage.service';
import { AiUnavailableError } from './ai-provider.types';
import { dayDate, utcDayString } from './ai-day';

const config = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as never;
const call = (over: Record<string, unknown> = {}) => ({ profile: 'public' as const, provider: 'openrouter', model: 'm1', ok: true, ms: 100, costUsd: 0.01, ...over });

function prismaWith(rows: unknown[] = []) {
  return {
    aiCallDaily: { findMany: jest.fn().mockResolvedValue(rows) },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
}

describe('AiUsageService', () => {
  it('works as a plain in-memory ledger when there is no database', () => {
    const usage = new AiUsageService(config({ AI_PUBLIC_DAILY_BUDGET_USD: '0.02' }));
    usage.record(call());
    usage.record(call());
    expect(usage.spentToday('public')).toBeCloseTo(0.02, 6);
    expect(() => usage.assertBudget('public')).toThrow(AiUnavailableError);
    expect(() => usage.assertBudget('owner')).not.toThrow();
  });

  it("starts from what the table says was already spent today, so a restart does not hand the budget back", async () => {
    const day = utcDayString();
    const prisma = prismaWith([
      { day: dayDate(day), profile: 'public', provider: 'openrouter', model: 'm1', calls: 900, failures: 3, fallbackCalls: 10, costMicros: 1_400_000, totalMs: 900_000 },
    ]);
    const usage = new AiUsageService(config(), prisma as never);
    await usage.onModuleInit();
    await usage.onModuleDestroy();
    expect(usage.spentToday('public')).toBeCloseTo(1.4, 6);
    usage.record(call({ costUsd: 0.2 }));
    expect(() => usage.assertBudget('public')).toThrow(AiUnavailableError);
  });

  it('adds new calls to the table with ON CONFLICT deltas, then re-reads the total (no double count)', async () => {
    const prisma = prismaWith([]);
    const usage = new AiUsageService(config(), prisma as never);
    usage.record(call({ costUsd: 0.5 }));
    usage.record(call({ costUsd: 0.25, ok: false }));
    prisma.aiCallDaily.findMany.mockResolvedValue([
      { day: dayDate(utcDayString()), profile: 'public', provider: 'openrouter', model: 'm1', calls: 2, failures: 1, fallbackCalls: 0, costMicros: 750_000, totalMs: 200 },
    ]);
    await usage.flush();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(usage.spentToday('public')).toBeCloseTo(0.75, 6);
    // Nothing is left pending, so a second flush writes nothing new.
    await usage.flush();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(usage.snapshot().profiles.public).toMatchObject({ calls: 2, failures: 1 });
    await usage.onModuleDestroy();
  });

  it('keeps counting in memory when the table cannot be written, and retries later', async () => {
    const prisma = prismaWith([]);
    prisma.$executeRaw.mockRejectedValueOnce(new Error('db down'));
    const usage = new AiUsageService(config(), prisma as never);
    usage.record(call({ costUsd: 0.3 }));
    await usage.flush();
    expect(usage.spentToday('public')).toBeCloseTo(0.3, 6);
    await usage.flush();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    await usage.onModuleDestroy();
  });

  it('counts calls answered by a later route of the chain, and refusals as named statistics', () => {
    const usage = new AiUsageService(config());
    usage.record(call({ routeIndex: 0 }));
    usage.record(call({ routeIndex: 2, model: 'm3' }));
    usage.record(call({ routeIndex: 1, ok: false }));
    const snap = usage.snapshot();
    expect(snap.profiles.public.fallbackCalls).toBe(1);
    expect(snap.models.find((m) => m.model === 'm3')?.fallbackCalls).toBe(1);
    usage.bump('keyword_fallback:public', 2);
    expect(usage.statToday('keyword_fallback:public')).toBe(2);
  });

  it('takes the budget from the admin setting when there is one', () => {
    const settings = { number: jest.fn().mockReturnValue(0.05) };
    const usage = new AiUsageService(config({ AI_PUBLIC_DAILY_BUDGET_USD: '9' }), undefined, settings as never);
    expect(usage.budgetUsd('public')).toBe(0.05);
    usage.record(call({ costUsd: 0.06 }));
    expect(() => usage.assertBudget('public')).toThrow(AiUnavailableError);
  });
});
