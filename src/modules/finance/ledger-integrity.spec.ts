import { LedgerService } from './ledger.service';
import { desiredLedgerDelta } from '../../common/money/booking-money';

describe('ledger integrity after a 30-event script', () => {
  it('is clean when every accrual matches desiredLedgerDelta', async () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      id: `b${i}`,
      venueId: 'v1',
      source: 'platform' as const,
      paymentModeSnapshot: 'online' as const,
      status: 'confirmed' as const,
      paymentStatus: 'paid' as const,
      checkedInAt: null,
      currency: 'EGP',
      baseAmount: 400,
      feeAmount: 20,
      discountAmount: 0,
      ownerFundedDiscount: 0,
      commissionBps: 1000,
      commissionAmount: 40,
      ownerNetAmount: 360,
      totalAmount: 420,
    }));
    const desired = events.map((b) =>
      desiredLedgerDelta({
        source: b.source,
        paymentMode: b.paymentModeSnapshot,
        status: b.status,
        paymentStatus: b.paymentStatus,
        checkedInAt: b.checkedInAt,
        money: { ownerNet: b.ownerNetAmount, total: b.totalAmount },
      }),
    );
    expect(desired.every((d) => d === 360)).toBe(true);

    const prisma = {
      venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', paymentMode: 'online', priceFromCurrency: 'EGP' }) },
      booking: { findMany: jest.fn().mockResolvedValue(events) },
      venueLedgerEntry: {
        aggregate: jest.fn().mockImplementation(async ({ where }: { where: { bookingId?: string; kind?: { in?: string[] } } }) => {
          if (where.bookingId) return { _sum: { amount: 360 } };
          if (where.kind?.in?.includes('payout_to_owner')) return { _sum: { amount: 0 } };
          return { _sum: { amount: 30 * 360 } };
        }),
      },
    };
    const commission = { resolveBps: jest.fn().mockResolvedValue(1000) };
    const report = await new LedgerService(prisma as never, commission as never).verifyLedgerIntegrity('v1');
    expect(report.ok).toBe(true);
    expect(report.balance).toBe(30 * 360);
  });
});
