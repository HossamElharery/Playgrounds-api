import { LedgerService } from './ledger.service';
import { CommissionService } from './commission.service';
import { computeBookingMoney } from '../../common/money/booking-money';

function bookingFixture(over: Record<string, unknown> = {}) {
  const money = computeBookingMoney({
    base: 400,
    fee: 20,
    discount: 0,
    ownerFundedDiscount: 0,
    commissionBps: 1000,
  });
  return {
    id: 'b1',
    venueId: 'v1',
    source: 'platform',
    paymentModeSnapshot: 'online',
    status: 'confirmed',
    paymentStatus: 'paid',
    checkedInAt: null,
    currency: 'EGP',
    baseAmount: 400,
    feeAmount: 20,
    discountAmount: 0,
    ownerFundedDiscount: 0,
    commissionBps: 1000,
    commissionAmount: money.commissionAmount,
    ownerNetAmount: money.ownerNet,
    totalAmount: money.total,
    ...over,
  };
}

function makeTx(initial?: ReturnType<typeof bookingFixture>) {
  const entries: Array<{
    kind: string;
    amount: number;
    bookingId?: string;
    reason?: string;
    venueId: string;
    currency: string;
  }> = [];
  const booking = initial ?? bookingFixture();
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: booking.id }]),
    booking: {
      findUnique: jest.fn(async () => booking),
    },
    venueLedgerEntry: {
      aggregate: jest.fn(async ({ where }: { where: { bookingId?: string } }) => {
        const rows = entries.filter((e) => e.bookingId === where.bookingId);
        return {
          _sum: { amount: rows.reduce((s, e) => s + e.amount, 0) },
          _count: { _all: rows.length },
        };
      }),
      create: jest.fn(async ({ data }: { data: (typeof entries)[number] }) => {
        entries.push(data);
        return data;
      }),
    },
    entries,
    bookingRow: booking,
  };
  return tx;
}

describe('LedgerService.syncBookingLedger', () => {
  const commission = {
    resolveBps: jest.fn().mockResolvedValue(1000),
  };
  let service: LedgerService;

  beforeEach(() => {
    service = new LedgerService({} as never, commission as unknown as CommissionService);
  });

  it('online paid → +ownerNet accrual; second call is a no-op', async () => {
    const tx = makeTx();
    const first = await service.syncBookingLedger(tx as never, 'b1', 'payment_paid');
    expect(first).toEqual({ wrote: true, delta: 360, desired: 360 });
    expect(tx.entries).toEqual([
      expect.objectContaining({ kind: 'booking_accrual', amount: 360 }),
    ]);
    const second = await service.syncBookingLedger(tx as never, 'b1');
    expect(second).toEqual({ wrote: false, delta: 0, desired: 360 });
    expect(tx.entries).toHaveLength(1);
  });

  it('refund after accrual writes a reversing adjustment', async () => {
    const tx = makeTx();
    await service.syncBookingLedger(tx as never, 'b1', 'payment_paid');
    tx.bookingRow.status = 'cancelled';
    tx.bookingRow.paymentStatus = 'refunded';
    const reversed = await service.syncBookingLedger(tx as never, 'b1', 'refund');
    expect(reversed).toEqual({ wrote: true, delta: -360, desired: 0 });
    expect(tx.entries[1]).toMatchObject({ kind: 'booking_adjustment', amount: -360, reason: 'refund' });
    const again = await service.syncBookingLedger(tx as never, 'b1', 'refund');
    expect(again.wrote).toBe(false);
  });

  it('at_venue check-in → ownerNet − total', async () => {
    const tx = makeTx(
      bookingFixture({
        paymentModeSnapshot: 'at_venue',
        status: 'completed',
        paymentStatus: 'pending',
        checkedInAt: new Date(),
      }),
    );
    const result = await service.syncBookingLedger(tx as never, 'b1', 'checked_in');
    expect(result).toEqual({ wrote: true, delta: -60, desired: -60 });
  });

  it('cancel after at_venue check-in reverses the accrual', async () => {
    const tx = makeTx(
      bookingFixture({
        paymentModeSnapshot: 'at_venue',
        status: 'completed',
        paymentStatus: 'pending',
        checkedInAt: new Date(),
      }),
    );
    await service.syncBookingLedger(tx as never, 'b1', 'checked_in');
    tx.bookingRow.status = 'cancelled';
    const reversed = await service.syncBookingLedger(tx as never, 'b1', 'cancelled');
    expect(reversed).toEqual({ wrote: true, delta: 60, desired: 0 });
  });

  it('manual bookings never write', async () => {
    const tx = makeTx(bookingFixture({ source: 'manual', status: 'completed', paymentStatus: 'paid' }));
    const result = await service.syncBookingLedger(tx as never, 'b1');
    expect(result.wrote).toBe(false);
    expect(tx.entries).toHaveLength(0);
  });

  it('uses snapshotted commission when the current rate has changed', async () => {
    commission.resolveBps.mockResolvedValue(1500);
    const tx = makeTx();
    await service.syncBookingLedger(tx as never, 'b1', 'payment_paid');
    expect(tx.entries[0].amount).toBe(360);
  });

  it('locks the booking row with SELECT FOR UPDATE', async () => {
    const tx = makeTx();
    await service.syncBookingLedger(tx as never, 'b1', 'payment_paid');
    expect(tx.$queryRaw).toHaveBeenCalled();
  });
});

describe('LedgerService.verifyLedgerIntegrity', () => {
  it('is clean after a scripted mix of 10 bookings + settlements', async () => {
    const bookings = [
      bookingFixture({ id: 'p-online', paymentModeSnapshot: 'online' }),
      bookingFixture({
        id: 'p-venue',
        paymentModeSnapshot: 'at_venue',
        status: 'completed',
        paymentStatus: 'pending',
        checkedInAt: new Date(),
      }),
      bookingFixture({
        id: 'p-promo',
        paymentModeSnapshot: 'online',
        discountAmount: 50,
        ownerFundedDiscount: 50,
        commissionAmount: 35,
        ownerNetAmount: 315,
        totalAmount: 370,
      }),
      bookingFixture({
        id: 'p-coins',
        paymentModeSnapshot: 'online',
        discountAmount: 20,
        ownerFundedDiscount: 0,
        commissionAmount: 40,
        ownerNetAmount: 360,
        totalAmount: 400,
      }),
      bookingFixture({
        id: 'p-override',
        paymentModeSnapshot: 'online',
        commissionBps: 1250,
        commissionAmount: 50,
        ownerNetAmount: 350,
      }),
      bookingFixture({ id: 'manual-1', source: 'manual', status: 'completed', paymentStatus: 'paid' }),
      bookingFixture({
        id: 'refunded',
        paymentModeSnapshot: 'online',
        status: 'cancelled',
        paymentStatus: 'refunded',
      }),
      bookingFixture({
        id: 'no-show-online',
        paymentModeSnapshot: 'online',
        status: 'no_show',
        paymentStatus: 'paid',
      }),
      bookingFixture({
        id: 'expected-at-venue',
        paymentModeSnapshot: 'at_venue',
        status: 'confirmed',
        paymentStatus: 'pending',
      }),
      bookingFixture({
        id: 'checked-in',
        paymentModeSnapshot: 'at_venue',
        status: 'completed',
        paymentStatus: 'pending',
        checkedInAt: new Date(),
      }),
    ];
    const entries = [
      { bookingId: 'p-online', kind: 'booking_accrual', amount: 360, venueId: 'v1', currency: 'EGP' },
      { bookingId: 'p-venue', kind: 'booking_accrual', amount: -60, venueId: 'v1', currency: 'EGP' },
      { bookingId: 'p-promo', kind: 'booking_accrual', amount: 315, venueId: 'v1', currency: 'EGP' },
      { bookingId: 'p-coins', kind: 'booking_accrual', amount: 360, venueId: 'v1', currency: 'EGP' },
      { bookingId: 'p-override', kind: 'booking_accrual', amount: 350, venueId: 'v1', currency: 'EGP' },
      { bookingId: 'no-show-online', kind: 'booking_accrual', amount: 360, venueId: 'v1', currency: 'EGP' },
      { bookingId: 'checked-in', kind: 'booking_accrual', amount: -60, venueId: 'v1', currency: 'EGP' },
      { bookingId: null, kind: 'payout_to_owner', amount: -200, venueId: 'v1', currency: 'EGP' },
      { bookingId: null, kind: 'remittance_from_owner', amount: 50, venueId: 'v1', currency: 'EGP' },
    ];
    const prisma = {
      venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', paymentMode: 'at_venue', priceFromCurrency: 'EGP' }) },
      booking: { findMany: jest.fn().mockResolvedValue(bookings) },
      venueLedgerEntry: {
        aggregate: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          let rows = entries;
          if (where.bookingId) rows = rows.filter((e) => e.bookingId === where.bookingId);
          if (where.kind && typeof where.kind === 'object' && 'in' in (where.kind as object)) {
            const kinds = (where.kind as { in: string[] }).in;
            rows = rows.filter((e) => kinds.includes(e.kind));
          }
          if (where.venueId) rows = rows.filter((e) => e.venueId === where.venueId);
          return { _sum: { amount: rows.reduce((s, e) => s + e.amount, 0) } };
        }),
        groupBy: jest.fn(),
      },
    };
    const service = new LedgerService(
      prisma as never,
      { resolveBps: jest.fn().mockResolvedValue(1000) } as unknown as CommissionService,
    );
    const result = await service.verifyLedgerIntegrity('v1');
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });
});
