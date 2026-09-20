import { AdminFinanceService } from './admin-finance.service';
import { ApiException } from '../../common/errors/api-exception';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { formatMoney, notifyFinance } from '../finance/finance-notify';

const admin: AuthenticatedUser = {
  id: 'admin-1',
  phone: '',
  name: 'Admin',
  roles: ['admin'],
};

const venue = {
  id: 'v1',
  ownerId: 'owner-1',
  paymentMode: 'at_venue',
  priceFromCurrency: 'EGP',
  paymentModeChangedAt: null,
  nameEn: 'Court',
  nameAr: 'ملعب',
};

function makePrisma(over: Record<string, unknown> = {}) {
  const ledgerEntries: Array<{ amount: number; kind: string; bookingId?: string }> = [];
  const settlements: Array<Record<string, unknown>> = [];
  const prisma = {
    venue: {
      findUnique: jest.fn().mockResolvedValue(venue),
      findMany: jest.fn().mockResolvedValue([{ ...venue, owner: { id: 'owner-1', name: 'Hossam' } }]),
      update: jest.fn().mockImplementation(async ({ data }: { data: object }) => ({ ...venue, ...data })),
      count: jest.fn().mockResolvedValue(3),
    },
    booking: {
      count: jest.fn().mockResolvedValue(2),
      aggregate: jest.fn().mockResolvedValue({ _sum: { totalAmount: 1000, feeAmount: 50, commissionAmount: 40, discountAmount: 0, ownerFundedDiscount: 0 } }),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    venueLedgerEntry: {
      groupBy: jest.fn().mockResolvedValue([{ venueId: 'v1', currency: 'EGP', _sum: { amount: 360 } }]),
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockImplementation(async ({ data }: { data: { amount: number; kind: string } }) => {
        ledgerEntries.push(data);
        return { id: 'e1', ...data };
      }),
      aggregate: jest.fn().mockResolvedValue({
        _sum: { amount: ledgerEntries.reduce((s, e) => s + e.amount, 0) },
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    venueSettlement: {
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 's1', ...data };
        settlements.push(row);
        return row;
      }),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockImplementation(async ({ data }: { data: object }) => ({ id: 's1', ...data })),
    },
    commissionSetting: { findMany: jest.fn().mockResolvedValue([]) },
    auditLogEntry: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    idempotencyKey: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'owner@example.com' }), findMany: jest.fn().mockResolvedValue([]) },
    court: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    ledgerEntries,
    settlements,
    ...over,
  };
  return prisma;
}

describe('AdminFinanceService', () => {
  const notifications = { create: jest.fn().mockResolvedValue({ id: 'n1' }) };
  const email = { sendFinanceNotice: jest.fn().mockResolvedValue(undefined) };
  const payments = { isOnlinePaymentsLive: jest.fn().mockReturnValue(false) };
  const commission = {
    resolveSource: jest.fn().mockResolvedValue({ bps: 1000, source: 'global' }),
    globalBps: jest.fn().mockResolvedValue(1000),
    setVenueBps: jest.fn().mockResolvedValue({ from: 1000, to: 1250, effective: 1250, appliesTo: 'new_bookings_only' }),
    notifyOwnerCommissionChanged: jest.fn().mockResolvedValue(undefined),
    setGlobalBps: jest.fn().mockResolvedValue({ from: 1000, to: 800, venuesWithoutOverride: 2 }),
  };
  const ledger = {
    getBalance: jest.fn().mockResolvedValue(360),
    listEntries: jest.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
    recordPayout: jest.fn().mockResolvedValue({}),
    recordRemittance: jest.fn().mockResolvedValue({}),
    verifyLedgerIntegrity: jest.fn().mockResolvedValue({ ok: true, balance: 360, issues: [] }),
    syncBookingLedger: jest.fn().mockResolvedValue({ wrote: true, delta: 0, desired: 0 }),
  };
  const summary = { getSummary: jest.fn().mockResolvedValue({ totals: { collectedRevenue: 400 } }) };
  const ownerBookings = { listReportBookings: jest.fn().mockResolvedValue({ items: [], nextCursor: undefined }) };
  const owner = { customers: jest.fn(), board: jest.fn(), calendar: jest.fn() };
  const bookings = { getSlotGrid: jest.fn().mockResolvedValue([]) };

  function service(prisma: object, pay = payments) {
    return new AdminFinanceService(
      prisma as never,
      commission as never,
      ledger as never,
      pay as never,
      notifications as never,
      email as never,
      summary as never,
      ownerBookings as never,
      owner as never,
      bookings as never,
      { get: () => undefined } as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    ledger.getBalance.mockResolvedValue(360);
    payments.isOnlinePaymentsLive.mockReturnValue(false);
  });

  it('balances: constant number of queries for 600 venues (no N+1)', async () => {
    const venues = Array.from({ length: 600 }, (_, i) => ({
      ...venue,
      id: `v${i}`,
      owner: { id: `o${i}`, name: `Owner ${i}` },
    }));
    const prisma = makePrisma({
      venue: { ...makePrisma().venue, findMany: jest.fn().mockResolvedValue(venues) },
    });
    await service(prisma).balances({ limit: 50 } as never);
    const calls = [
      prisma.venue.findMany,
      prisma.venueLedgerEntry.groupBy,
      prisma.venueSettlement.groupBy,
      prisma.commissionSetting.findMany,
    ].reduce((n, fn) => n + (fn as jest.Mock).mock.calls.length, 0);
    expect(calls).toBeLessThanOrEqual(5);
    expect(prisma.venue.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.venueLedgerEntry.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('venueAudit: cursor-paginated, matches venue-scoped and metadata.venueId events', async () => {
    const rows = Array.from({ length: 31 }, (_, i) => ({ id: `a${i}`, action: 'x' }));
    const prisma = makePrisma();
    prisma.auditLogEntry.findMany = jest.fn().mockResolvedValue(rows);
    const page = await service(prisma).venueAudit('v1', 'cur', 30);
    expect(page.items).toHaveLength(30);
    expect(page.nextCursor).toBe('a29');
    const args = (prisma.auditLogEntry.findMany as jest.Mock).mock.calls[0][0];
    expect(args.take).toBe(31);
    expect(args.cursor).toEqual({ id: 'cur' });
    expect(args.where.OR).toEqual([
      { targetType: 'venue', targetId: 'v1' },
      { metadata: { path: ['venueId'], equals: 'v1' } },
    ]);
  });

  it('venueLedger: running balance on a later page starts below the newer entries', async () => {
    const prisma = makePrisma();
    prisma.venueLedgerEntry.aggregate = jest.fn().mockResolvedValue({ _sum: { amount: 100 } });
    ledger.getBalance.mockResolvedValue(500);
    const createdAt = new Date('2026-09-01T10:00:00Z');
    ledger.listEntries.mockResolvedValue({
      items: [
        { id: 'e2', amount: 40, createdAt },
        { id: 'e1', amount: 60, createdAt },
      ],
      nextCursor: undefined,
    });
    const out = await service(prisma).venueLedger('v1', 'cursor-1');
    // balance 500 minus 100 already shown on earlier pages → first row shows 400
    expect(out.items.map((i: { runningBalance: number }) => i.runningBalance)).toEqual([400, 360]);
  });

  it('rejects switching to online while the provider is not live', async () => {
    const prisma = makePrisma();
    try {
      await service(prisma).patchPaymentMode(admin, 'v1', { paymentMode: 'online', reason: 'try card' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiException);
      expect((err as ApiException).getResponse()).toEqual(
        expect.objectContaining({ code: 'ONLINE_PAYMENTS_NOT_LIVE' }),
      );
    }
  });

  it('allows switching to online when the live flag is mocked true', async () => {
    const prisma = makePrisma();
    payments.isOnlinePaymentsLive.mockReturnValue(true);
    const result = await service(prisma).patchPaymentMode(admin, 'v1', {
      paymentMode: 'online',
      reason: 'cards live now',
    });
    expect(result.paymentMode).toBe('online');
    expect(notifications.create).toHaveBeenCalled();
  });

  it('payout reduces the balance exactly once for the same idempotency key', async () => {
    const prisma = makePrisma();
    ledger.getBalance.mockResolvedValueOnce(360).mockResolvedValueOnce(0).mockResolvedValue(0);
    const first = await service(prisma).payout(admin, 'v1', {
      amount: 360,
      currency: 'EGP',
      method: 'bank',
      reason: 'weekly payout',
    }, 'key-1');
    expect(ledger.recordPayout).toHaveBeenCalledTimes(1);
    prisma.idempotencyKey.findUnique.mockResolvedValue({ responseBody: first });
    const second = await service(prisma).payout(admin, 'v1', {
      amount: 360,
      currency: 'EGP',
      method: 'bank',
      reason: 'weekly payout',
    }, 'key-1');
    expect(ledger.recordPayout).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('rejects a stale expectedBalance', async () => {
    const prisma = makePrisma();
    await expect(
      service(prisma).payout(admin, 'v1', {
        amount: 100,
        currency: 'EGP',
        method: 'bank',
        reason: 'stale screen',
        expectedBalance: 999,
      }),
    ).rejects.toBeInstanceOf(ApiException);
  });

  it('pending remittance writes no ledger; confirm posts +amount; reject none', async () => {
    const prisma = makePrisma();
    prisma.venueSettlement.findUnique.mockResolvedValue({
      id: 's1',
      venueId: 'v1',
      amount: 200,
      currency: 'EGP',
      status: 'pending_confirmation',
    });
    await service(prisma).confirmSettlement(admin, 's1', 'got the transfer');
    expect(ledger.recordRemittance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: 200 }),
    );
    ledger.recordRemittance.mockClear();
    prisma.venueSettlement.findUnique.mockResolvedValue({
      id: 's2',
      venueId: 'v1',
      amount: 200,
      currency: 'EGP',
      status: 'pending_confirmation',
    });
    await service(prisma).rejectSettlement(admin, 's2', 'wrong amount sent');
    expect(ledger.recordRemittance).not.toHaveBeenCalled();
  });

  it('adjustments are new immutable rows', async () => {
    const prisma = makePrisma();
    await service(prisma).adjustment(admin, 'v1', { amount: -50, reason: 'fix duplicate accrual' });
    expect(prisma.venueLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'manual_adjustment', amount: -50 }),
      }),
    );
    expect(prisma.venueLedgerEntry.update).toBeUndefined();
  });

  it('owner and admin summaries share the same provider', async () => {
    const prisma = makePrisma();
    const a = await service(prisma).venueSummary(admin, 'v1', 'today');
    expect(summary.getSummary).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ['admin'] }),
      'v1',
      'today',
      undefined,
      undefined,
    );
    expect(a.totals.collectedRevenue).toBe(400);
  });

  it('notifies the owner with formatted amounts', async () => {
    expect(formatMoney(1250, 'EGP')).toMatch(/1[,.]250/);
    await notifyFinance(notifications as never, {
      userId: 'owner-1',
      titleEn: 'Matchena sent you 1,250 EGP',
      titleAr: 'ماتشنا بعتتلك 1,250 EGP',
      bodyEn: 'via bank',
      bodyAr: 'بنك',
      payload: { amount: 1250 },
    });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1',
        category: 'system',
        payload: { amount: 1250 },
        deepLink: '/owner/earnings?section=matchena-account',
      }),
    );
  });
});

describe('commission change is new-bookings-only', () => {
  it('setVenueBps response says new_bookings_only', async () => {
    const { CommissionService } = require('../finance/commission.service');
    const prisma = {
      venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'o' }) },
      commissionSetting: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue({ percentageBps: 1000 }),
        upsert: jest.fn(),
      },
      auditLogEntry: { create: jest.fn() },
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const svc = new CommissionService(prisma, { create: jest.fn() });
    const result = await svc.setVenueBps('v1', 1250, 'admin', 'peak padel');
    expect(result.appliesTo).toBe('new_bookings_only');
  });
});
