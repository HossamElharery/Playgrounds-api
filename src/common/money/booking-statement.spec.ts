import { computeBookingMoney } from './booking-money';
import { buildBookingStatement, type StatementBooking } from './booking-statement';

function platform(input: { base: number; fee: number; discount: number; ownerFundedDiscount: number }): StatementBooking {
  const m = computeBookingMoney({ ...input, commissionBps: 1000 });
  return {
    source: 'platform',
    baseAmount: m.base,
    feeAmount: m.fee,
    discountAmount: m.discount,
    totalAmount: m.total,
    ownerFundedDiscount: m.ownerFundedDiscount,
    commissionBps: m.commissionBps,
    commissionAmount: m.commissionAmount,
    ownerNetAmount: m.ownerNet,
    currency: 'EGP',
  };
}

describe('buildBookingStatement', () => {
  it('explains a venue-funded discount: 250 − 38 = 212, 10% = 21, keeps 191', () => {
    const s = buildBookingStatement(platform({ base: 250, fee: 10, discount: 38, ownerFundedDiscount: 38 }), 0);
    expect(s.listPrice).toBe(250);
    expect(s.ownerDiscount).toBe(38);
    expect(s.venueGross).toBe(212);
    expect(s.commission).toBe(21);
    expect(s.ownerNet).toBe(191);
    // The lines add up on screen: 250 − 38 = 212; 212 − 21 = 191.
    expect(s.lines.map((l) => [l.key, l.kind, l.amount])).toEqual([
      ['listPrice', 'plus', 250],
      ['ownerDiscount', 'minus', 38],
      ['venueGross', 'subtotal', 212],
      ['commission', 'minus', 21],
      ['ownerNet', 'total', 191],
    ]);
    expect(s.customerTotal).toBe(222);
    expect(s.outstanding).toBe(222);
  });

  it('a plain Matchena booking has no discount line', () => {
    const s = buildBookingStatement(platform({ base: 400, fee: 20, discount: 0, ownerFundedDiscount: 0 }), 420);
    expect(s.lines.map((l) => l.key)).toEqual(['listPrice', 'commission', 'ownerNet']);
    expect(s.commission).toBe(40);
    expect(s.ownerNet).toBe(360);
    expect(s.customerFee).toBe(20);
    expect(s.outstanding).toBe(0);
  });

  it('a Matchena-funded discount (coins) never reduces what the venue is owed', () => {
    const s = buildBookingStatement(platform({ base: 400, fee: 20, discount: 20, ownerFundedDiscount: 0 }), 0);
    expect(s.ownerDiscount).toBe(0);
    expect(s.platformDiscount).toBe(20);
    expect(s.venueGross).toBe(400);
    expect(s.ownerNet).toBe(360);
    expect(s.lines.map((l) => l.key)).not.toContain('ownerDiscount');
  });

  it('a manual booking with a partial payment shows what is still owed', () => {
    const s = buildBookingStatement(
      { source: 'manual', baseAmount: 300, feeAmount: 0, discountAmount: 0, totalAmount: 300, ownerFundedDiscount: 0, commissionBps: null, commissionAmount: null, ownerNetAmount: null, currency: 'EGP' },
      100,
    );
    expect(s.kind).toBe('manual');
    expect(s.commission).toBe(0);
    expect(s.ownerNet).toBe(300);
    expect(s.received).toBe(100);
    expect(s.outstanding).toBe(200);
    expect(s.lines).toEqual([{ key: 'listPrice', kind: 'plus', amount: 300 }]);
  });

  it('reports refunds separately and never lets outstanding go negative', () => {
    const s = buildBookingStatement(
      { source: 'manual', baseAmount: 300, feeAmount: 0, discountAmount: 0, totalAmount: 300, ownerFundedDiscount: 0, commissionBps: null, commissionAmount: null, ownerNetAmount: null, currency: 'EGP' },
      300,
      50,
    );
    expect(s.refunded).toBe(50);
    expect(s.outstanding).toBe(0);
  });

  it('a cancelled booking owes nothing, whatever was or was not paid', () => {
    const base = { source: 'manual' as const, baseAmount: 300, feeAmount: 0, discountAmount: 0, totalAmount: 300, ownerFundedDiscount: 0, commissionBps: null, commissionAmount: null, ownerNetAmount: null, currency: 'EGP' };
    expect(buildBookingStatement({ ...base, status: 'cancelled' }, 0).outstanding).toBe(0);
    expect(buildBookingStatement({ ...base, status: 'cancelled' }, 100).outstanding).toBe(0);
    // ...but the deposit that was kept is still reported as received.
    expect(buildBookingStatement({ ...base, status: 'cancelled' }, 100).received).toBe(100);
    expect(buildBookingStatement({ ...base, status: 'confirmed' }, 100).outstanding).toBe(200);
  });
});
