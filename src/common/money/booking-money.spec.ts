import {
  BookingMoney,
  BookingStatusKind,
  DEFAULT_COMMISSION_BPS,
  LedgerBookingState,
  MoneyInputError,
  PaymentStatusKind,
  VenuePaymentModeKind,
  computeBookingMoney,
  computeCommission,
  desiredLedgerDelta,
  roundHalfUp,
} from './booking-money';

function money(over: Partial<{
  base: number;
  fee: number;
  discount: number;
  ownerFundedDiscount: number;
  commissionBps: number;
}> = {}): BookingMoney {
  return computeBookingMoney({
    base: 400,
    fee: 20,
    discount: 0,
    ownerFundedDiscount: 0,
    commissionBps: DEFAULT_COMMISSION_BPS,
    ...over,
  });
}

describe('roundHalfUp', () => {
  it('rounds .5 up away from zero', () => {
    expect(roundHalfUp(33.5)).toBe(34);
    expect(roundHalfUp(-33.5)).toBe(-34);
  });
  it('rounds .3 down toward zero on the positive side', () => {
    expect(roundHalfUp(33.3)).toBe(33);
    expect(roundHalfUp(33.49)).toBe(33);
  });
  it('rejects NaN / Infinity', () => {
    expect(() => roundHalfUp(Number.NaN)).toThrow(MoneyInputError);
    expect(() => roundHalfUp(Number.POSITIVE_INFINITY)).toThrow(MoneyInputError);
  });
});

describe('computeCommission', () => {
  it('example 1: 10% of 400 = 40', () => {
    expect(computeCommission(400, 1000)).toBe(40);
  });
  it('example 4: 12.5% of 400 = 50', () => {
    expect(computeCommission(400, 1250)).toBe(50);
  });
  it('example 5: 10% of 333 = 33; 10% of 335 = 34', () => {
    expect(computeCommission(333, 1000)).toBe(33);
    expect(computeCommission(335, 1000)).toBe(34);
  });
  it('bps 0 and 5000', () => {
    expect(computeCommission(400, 0)).toBe(0);
    expect(computeCommission(400, 5000)).toBe(200);
  });
  it('rejects out of range bps', () => {
    expect(() => computeCommission(400, -1)).toThrow(MoneyInputError);
    expect(() => computeCommission(400, 5001)).toThrow(MoneyInputError);
    expect(() => computeCommission(400, 10.5)).toThrow(MoneyInputError);
  });
});

describe('computeBookingMoney — worked examples (00 §4)', () => {
  it('1. plain platform booking, 10%, no discount', () => {
    const m = money();
    expect(m).toMatchObject({
      base: 400,
      fee: 20,
      discount: 0,
      total: 420,
      ownerGross: 400,
      commissionAmount: 40,
      ownerNet: 360,
      platformTake: 60,
      platformFundedDiscount: 0,
    });
  });

  it('2. owner-funded venue promo of 50', () => {
    const m = money({ discount: 50, ownerFundedDiscount: 50 });
    expect(m).toMatchObject({
      total: 370,
      ownerGross: 350,
      commissionAmount: 35,
      ownerNet: 315,
      platformTake: 55,
      platformFundedDiscount: 0,
    });
  });

  it('3. platform-funded coin discount of 20', () => {
    const m = money({ discount: 20, ownerFundedDiscount: 0 });
    expect(m).toMatchObject({
      total: 400,
      ownerGross: 400,
      commissionAmount: 40,
      ownerNet: 360,
      platformTake: 40,
      platformFundedDiscount: 20,
    });
  });

  it('4. commission override 12.5%', () => {
    const m = money({ commissionBps: 1250 });
    expect(m.commissionAmount).toBe(50);
    expect(m.ownerNet).toBe(350);
  });

  it('zero-price booking', () => {
    const m = money({ base: 0, fee: 0 });
    expect(m).toMatchObject({
      total: 0,
      ownerGross: 0,
      commissionAmount: 0,
      ownerNet: 0,
      platformTake: 0,
    });
  });

  it('discount larger than base+fee floors total at 0', () => {
    const m = money({ base: 100, fee: 5, discount: 200, ownerFundedDiscount: 100 });
    expect(m.total).toBe(0);
    expect(m.ownerGross).toBe(0);
    expect(m.commissionAmount).toBe(0);
    expect(m.ownerNet).toBe(0);
    expect(m.platformTake).toBe(0);
  });

  it('rejects negative / NaN / non-integer / owner discount > base', () => {
    expect(() => money({ base: -1 })).toThrow(MoneyInputError);
    expect(() => money({ fee: 1.5 })).toThrow(MoneyInputError);
    expect(() =>
      computeBookingMoney({
        base: 100,
        fee: 0,
        discount: 0,
        ownerFundedDiscount: 0,
        commissionBps: Number.NaN,
      }),
    ).toThrow(MoneyInputError);
    expect(() => money({ ownerFundedDiscount: 401 })).toThrow(MoneyInputError);
    expect(() => money({ discount: 10, ownerFundedDiscount: 11 })).toThrow(
      MoneyInputError,
    );
  });
});

describe('desiredLedgerDelta — worked examples', () => {
  const plain = money();

  it('1. online paid confirmed → +360; at_venue completed → -60', () => {
    expect(
      desiredLedgerDelta({
        source: 'platform',
        paymentMode: 'online',
        status: 'confirmed',
        paymentStatus: 'paid',
        checkedInAt: null,
        money: plain,
      }),
    ).toBe(360);
    expect(
      desiredLedgerDelta({
        source: 'platform',
        paymentMode: 'at_venue',
        status: 'completed',
        paymentStatus: 'pending',
        checkedInAt: new Date(),
        money: plain,
      }),
    ).toBe(-60);
  });

  it('2. owner promo: online +315; at_venue -55', () => {
    const m = money({ discount: 50, ownerFundedDiscount: 50 });
    expect(
      desiredLedgerDelta({
        source: 'platform',
        paymentMode: 'online',
        status: 'confirmed',
        paymentStatus: 'paid',
        checkedInAt: null,
        money: m,
      }),
    ).toBe(315);
    expect(
      desiredLedgerDelta({
        source: 'platform',
        paymentMode: 'at_venue',
        status: 'completed',
        paymentStatus: 'paid',
        checkedInAt: new Date(),
        money: m,
      }),
    ).toBe(-55);
  });

  it('3. coin discount: online +360; at_venue -40', () => {
    const m = money({ discount: 20, ownerFundedDiscount: 0 });
    expect(
      desiredLedgerDelta({
        source: 'platform',
        paymentMode: 'online',
        status: 'confirmed',
        paymentStatus: 'paid',
        checkedInAt: null,
        money: m,
      }),
    ).toBe(360);
    expect(
      desiredLedgerDelta({
        source: 'platform',
        paymentMode: 'at_venue',
        status: 'completed',
        paymentStatus: 'paid',
        checkedInAt: new Date(),
        money: m,
      }),
    ).toBe(-40);
  });

  it('6. cancellation after online accrual → desired 0', () => {
    expect(
      desiredLedgerDelta({
        source: 'platform',
        paymentMode: 'online',
        status: 'cancelled',
        paymentStatus: 'refunded',
        checkedInAt: null,
        money: plain,
      }),
    ).toBe(0);
  });

  it('manual bookings never touch the ledger', () => {
    expect(
      desiredLedgerDelta({
        source: 'manual',
        paymentMode: 'at_venue',
        status: 'completed',
        paymentStatus: 'paid',
        checkedInAt: new Date(),
        money: plain,
      }),
    ).toBe(0);
  });
});

describe('desiredLedgerDelta — full state table', () => {
  const m = money();
  const statuses: BookingStatusKind[] = [
    'held',
    'confirmed',
    'cancelled',
    'completed',
    'no_show',
  ];
  const payments: PaymentStatusKind[] = [
    'pending',
    'paid',
    'failed',
    'refunded',
    'partial',
  ];
  const modes: VenuePaymentModeKind[] = ['online', 'at_venue'];
  const checked: Array<Date | null> = [null, new Date('2026-09-01T12:00:00Z')];

  it('covers every mode × status × paymentStatus × checkedIn combination', () => {
    let n = 0;
    for (const paymentMode of modes) {
      for (const status of statuses) {
        for (const paymentStatus of payments) {
          for (const checkedInAt of checked) {
            n += 1;
            const state: LedgerBookingState = {
              source: 'platform',
              paymentMode,
              status,
              paymentStatus,
              checkedInAt,
              money: m,
            };
            const delta = desiredLedgerDelta(state);
            if (paymentMode === 'online') {
              const counts =
                paymentStatus === 'paid' &&
                (status === 'confirmed' ||
                  status === 'completed' ||
                  status === 'no_show');
              expect(delta).toBe(counts ? 360 : 0);
            } else {
              const counts =
                status !== 'cancelled' &&
                (status === 'completed' || checkedInAt != null);
              expect(delta).toBe(counts ? -60 : 0);
            }
          }
        }
      }
    }
    expect(n).toBe(100);
  });
});
