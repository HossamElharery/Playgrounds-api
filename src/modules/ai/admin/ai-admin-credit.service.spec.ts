import { AiAdminCreditService } from './ai-admin-credit.service';

const NOW = new Date('2026-11-10T12:00:00Z');

function build(over: Record<string, unknown> = {}) {
  const sub = {
    id: 'sub1',
    venueId: 'v1',
    planKey: 'pro',
    currency: 'EGP',
    startedAt: new Date('2026-10-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
    graceDays: 14,
    aiAssistantEnabled: true,
    aiCreditOverrideUsd: null,
    aiTrial: true,
    ...over,
  };
  const tx = {
    aiCreditTopUp: { create: jest.fn().mockResolvedValue({ id: 't1' }) },
    venueSubscription: { update: jest.fn().mockResolvedValue({}) },
    auditLogEntry: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    ...tx,
    venue: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'v1',
        nameEn: 'Arena',
        nameAr: 'الساحة',
        currency: 'EGP',
      }),
    },
    aiCreditTopUp: { findMany: jest.fn().mockResolvedValue([]) },
    aiOwnerEventLog: {
      groupBy: jest
        .fn()
        .mockResolvedValue([{ venueId: 'v1', _sum: { costMicros: 120_000 } }]),
    },
    $transaction: jest.fn(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (t: unknown) => unknown)(tx)
        : Promise.all(arg as unknown[]),
    ),
  };
  const view = {
    venueId: 'v1',
    enabled: true,
    trial: true,
    source: 'trial',
    allowanceUsd: 0.5,
    paused: false,
    usedUsd: 0.12,
    topUpUsd: 0,
    balanceUsd: 0.38,
    cycleStartedAt: null,
    cycleEndsAt: null,
    roomMicros: 500_000,
  };
  const credit = {
    state: jest.fn().mockResolvedValue(view),
    planUsd: jest.fn().mockReturnValue(4),
    trialUsd: jest.fn().mockReturnValue(0.5),
  };
  const subscriptions = { ensure: jest.fn().mockResolvedValue(sub) };
  const service = new AiAdminCreditService(
    prisma as never,
    credit as never,
    subscriptions as never,
  );
  return { service, prisma, tx };
}

describe('AiAdminCreditService', () => {
  it('records a top-up with both numbers, credits the venue, and keeps the amount received out of the audit trail', async () => {
    const { service, tx } = build();
    await service.topUp('admin-1', 'v1', {
      receivedAmount: 25_000,
      receivedCurrency: 'EGP',
      creditedUsd: 3,
      note: ' cash ',
    });
    expect(tx.aiCreditTopUp.create.mock.calls[0][0].data).toMatchObject({
      subscriptionId: 'sub1',
      venueId: 'v1',
      receivedAmount: 25_000,
      receivedCurrency: 'EGP',
      creditedMicros: 3_000_000,
      note: 'cash',
      recordedById: 'admin-1',
    });
    expect(tx.venueSubscription.update.mock.calls[0][0].data).toEqual({
      aiTopUpMicros: { increment: 3_000_000 },
    });
    const audit = tx.auditLogEntry.create.mock.calls[0][0].data;
    expect(audit.action).toBe('ai.credit.top_up');
    expect(JSON.stringify(audit.metadata)).not.toMatch(/received|25000/);
  });

  it('switches the assistant off, sets an override and ends a trial in one audited change', async () => {
    const { service, prisma } = build();
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    try {
      await service.update('admin-1', 'v1', {
        enabled: false,
        overrideUsd: 6,
        endTrial: true,
      });
    } finally {
      jest.useRealTimers();
    }
    const data = prisma.venueSubscription.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      aiAssistantEnabled: false,
      aiCreditOverrideUsd: 6,
      aiTrial: false,
      aiCycleSpentMicros: 0,
      aiCycleStartedAt: NOW,
    });
    expect(prisma.auditLogEntry.create.mock.calls[0][0].data).toMatchObject({
      action: 'ai.credit.update',
      targetId: 'v1',
    });
  });

  it('writes nothing when nothing changed', async () => {
    const { service, prisma } = build({ aiTrial: false });
    await service.update('admin-1', 'v1', { enabled: true, endTrial: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('shows the admin the real logged cost next to the balance, without internal fields', async () => {
    const { service } = build();
    const d = await service.detail('v1');
    expect(d).toMatchObject({
      planUsd: 4,
      trialUsd: 0.5,
      realCostUsd: 0.12,
      balanceUsd: 0.38,
    });
    expect(d).not.toHaveProperty('roomMicros');
  });
});
