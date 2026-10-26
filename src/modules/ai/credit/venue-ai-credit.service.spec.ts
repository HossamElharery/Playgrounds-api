import { VenueAiCreditService } from './venue-ai-credit.service';
import type { CreditRow } from './venue-ai-credit';

const DAY = 86_400_000;
const NOW = new Date('2026-11-10T12:00:00Z');

const row = (over: Partial<CreditRow> = {}): CreditRow => ({
  venueId: 'v1',
  planKey: 'pro',
  currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
  graceDays: 14,
  aiAssistantEnabled: true,
  aiCreditOverrideUsd: null,
  aiTrial: false,
  aiCycleStartedAt: new Date(NOW.getTime() - 5 * DAY),
  aiCycleEndsAt: new Date(NOW.getTime() + 25 * DAY),
  aiCycleSpentMicros: 0,
  aiTopUpMicros: 0,
  ...over,
});

function build(stored: CreditRow | null, opts: { otherTrial?: number } = {}) {
  const prisma = {
    venueSubscription: {
      findUnique: jest.fn().mockResolvedValue(stored),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      aggregate: jest.fn().mockResolvedValue({
        _sum: { aiCycleSpentMicros: opts.otherTrial ?? 0 },
      }),
    },
    venue: { findUnique: jest.fn().mockResolvedValue({ ownerId: 'o1' }) },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const values: Record<string, number> = {
    creditProUsd: 4,
    creditStarterUsd: 1.5,
    creditTrialUsd: 0.5,
  };
  const settings = { number: jest.fn((k: string) => values[k] ?? null) };
  const subscriptions = {
    ensure: jest
      .fn()
      .mockResolvedValue(
        row({ aiTrial: true, aiCycleStartedAt: null, aiCycleEndsAt: null }),
      ),
  };
  const service = new VenueAiCreditService(
    prisma as never,
    settings as never,
    subscriptions as never,
  );
  return { service, prisma, settings, subscriptions };
}

describe('VenueAiCreditService', () => {
  it('lets the assistant run while the venue has credit', async () => {
    const { service } = build(row({ aiCycleSpentMicros: 1_000_000 }));
    const verdict = await service.check('v1', NOW);
    expect(verdict.ok).toBe(true);
    expect(verdict.view.balanceUsd).toBe(3);
  });

  it('stops it when an admin switched it off, even with credit left', async () => {
    const { service } = build(row({ aiAssistantEnabled: false }));
    expect(await service.check('v1', NOW)).toMatchObject({
      ok: false,
      reason: 'disabled',
    });
  });

  it('stops it when the window’s allowance and the top-ups are used up', async () => {
    const { service } = build(row({ aiCycleSpentMicros: 4_000_000 }));
    expect(await service.check('v1', NOW)).toMatchObject({
      ok: false,
      reason: 'exhausted',
    });
  });

  it('starts the trial for a venue that has no subscription yet', async () => {
    const { service, subscriptions } = build(null);
    const verdict = await service.check('v1', NOW);
    expect(subscriptions.ensure).toHaveBeenCalledWith('v1');
    expect(verdict.view).toMatchObject({ trial: true, allowanceUsd: 0.5 });
  });

  it('counts the same owner’s other trial venues against one trial credit', async () => {
    const { service, prisma } = build(
      row({ aiTrial: true, aiCycleEndsAt: null }),
      { otherTrial: 500_000 },
    );
    expect(await service.check('v1', NOW)).toMatchObject({
      ok: false,
      reason: 'exhausted',
    });
    expect(
      prisma.venueSubscription.aggregate.mock.calls[0][0].where,
    ).toMatchObject({
      aiTrial: true,
      venueId: { not: 'v1' },
      venue: { ownerId: 'o1' },
    });
  });

  it('rolls a window that ran out over once, guarded against a concurrent roll', async () => {
    const ended = new Date(NOW.getTime() - DAY);
    const { service, prisma } = build(
      row({ aiCycleEndsAt: ended, aiCycleSpentMicros: 4_000_000 }),
    );
    const verdict = await service.check('v1', NOW);
    expect(verdict.ok).toBe(true);
    const call = prisma.venueSubscription.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      venueId: 'v1',
      aiTrial: false,
      aiCycleEndsAt: ended,
    });
    expect(call.data).toMatchObject({
      aiCycleSpentMicros: 0,
      aiCycleStartedAt: ended,
    });
  });

  it('charges the real cost in one statement with the allowance room it was checked against', async () => {
    const { service, prisma } = build(row());
    const verdict = await service.check('v1', NOW);
    await service.charge('v1', verdict.view, 0.0035);
    const [, room, cost] = prisma.$executeRaw.mock.calls[0];
    expect(room).toBe(4_000_000);
    expect(cost).toBe(3500);
  });

  it('skips free calls and never throws into the assistant when charging fails', async () => {
    const { service, prisma } = build(row());
    await service.charge('v1', { roomMicros: 1 }, 0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    prisma.$executeRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.charge('v1', { roomMicros: 1 }, 0.01),
    ).resolves.toBeUndefined();
  });
});
