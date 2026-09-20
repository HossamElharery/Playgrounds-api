import {
  computeBookingMoney,
  desiredLedgerDelta,
  type BookingMoney,
  type LedgerBookingState,
} from '../common/money/booking-money';

export interface NumericCase {
  id: string;
  label: string;
  input: Parameters<typeof computeBookingMoney>[0];
  expected: Partial<BookingMoney> & { ledgerOnline: number; ledgerAtVenue: number };
  extra?: { source?: 'platform' | 'manual'; paymentStatus?: LedgerBookingState['paymentStatus']; status?: LedgerBookingState['status'] };
}

/** Hand-computed fixtures from 00 §4 / 06 §2. Amounts match the money-module integer convention. */
export const QA_NUMERIC_CASES: NumericCase[] = [
  {
    id: 'a',
    label: 'base 400 @10% online → +360',
    input: { base: 400, fee: 20, discount: 0, ownerFundedDiscount: 0, commissionBps: 1000 },
    expected: { total: 420, commissionAmount: 40, ownerNet: 360, ledgerOnline: 360, ledgerAtVenue: -60 },
  },
  {
    id: 'b',
    label: 'same at_venue → −60',
    input: { base: 400, fee: 20, discount: 0, ownerFundedDiscount: 0, commissionBps: 1000 },
    expected: { total: 420, commissionAmount: 40, ownerNet: 360, ledgerOnline: 360, ledgerAtVenue: -60 },
  },
  {
    id: 'c',
    label: 'base 400 owner promo 50 → +315 / −55',
    input: { base: 400, fee: 20, discount: 50, ownerFundedDiscount: 50, commissionBps: 1000 },
    expected: { total: 370, ownerGross: 350, commissionAmount: 35, ownerNet: 315, ledgerOnline: 315, ledgerAtVenue: -55 },
  },
  {
    id: 'd',
    label: 'coin 20 → +360 / −40',
    input: { base: 400, fee: 20, discount: 20, ownerFundedDiscount: 0, commissionBps: 1000 },
    expected: { total: 400, ownerGross: 400, commissionAmount: 40, ownerNet: 360, ledgerOnline: 360, ledgerAtVenue: -40 },
  },
  {
    id: 'e',
    label: '12.5% → commission 50, net 350',
    input: { base: 400, fee: 20, discount: 0, ownerFundedDiscount: 0, commissionBps: 1250 },
    expected: { total: 420, commissionAmount: 50, ownerNet: 350, ledgerOnline: 350, ledgerAtVenue: -70 },
  },
  {
    id: 'f',
    label: 'manual 300 paid + 150 unpaid → commission 0',
    input: { base: 300, fee: 0, discount: 0, ownerFundedDiscount: 0, commissionBps: 1000 },
    expected: { total: 300, ledgerOnline: 0, ledgerAtVenue: 0 },
    extra: { source: 'manual', paymentStatus: 'paid', status: 'confirmed' },
  },
  {
    id: 'g',
    label: 'refund reversal → net 0',
    input: { base: 400, fee: 20, discount: 0, ownerFundedDiscount: 0, commissionBps: 1000 },
    expected: { total: 420, ownerNet: 360, ledgerOnline: 0, ledgerAtVenue: 0 },
    extra: { source: 'platform', paymentStatus: 'refunded', status: 'cancelled' },
  },
];

export interface NumericRow {
  id: string;
  label: string;
  ok: boolean;
  expected: Record<string, number>;
  actual: Record<string, number>;
}

export function verifyNumericCases(): NumericRow[] {
  return QA_NUMERIC_CASES.map((c) => {
    const money = computeBookingMoney(c.input);
    const source = c.extra?.source ?? 'platform';
    const status = c.extra?.status ?? 'completed';
    const paymentStatus = c.extra?.paymentStatus ?? 'paid';
    const online = desiredLedgerDelta({
      source,
      paymentMode: 'online',
      status,
      paymentStatus,
      checkedInAt: status === 'completed' ? new Date() : null,
      money: { ownerNet: money.ownerNet, total: money.total },
    });
    const atVenue = desiredLedgerDelta({
      source,
      paymentMode: 'at_venue',
      status,
      paymentStatus,
      checkedInAt: status === 'completed' ? new Date() : null,
      money: { ownerNet: money.ownerNet, total: money.total },
    });
    const actual: Record<string, number> = {
      ledgerOnline: online,
      ledgerAtVenue: atVenue,
    };
    if (c.expected.total != null) actual.total = money.total;
    if (c.expected.commissionAmount != null) actual.commissionAmount = money.commissionAmount;
    if (c.expected.ownerNet != null) actual.ownerNet = money.ownerNet;
    if (c.expected.ownerGross != null) actual.ownerGross = money.ownerGross;
    const expected: Record<string, number> = {
      ledgerOnline: c.expected.ledgerOnline,
      ledgerAtVenue: c.expected.ledgerAtVenue,
    };
    if (c.expected.total != null) expected.total = c.expected.total;
    if (c.expected.commissionAmount != null) expected.commissionAmount = c.expected.commissionAmount;
    if (c.expected.ownerNet != null) expected.ownerNet = c.expected.ownerNet;
    if (c.expected.ownerGross != null) expected.ownerGross = c.expected.ownerGross;
    const ok = Object.keys(expected).every((k) => actual[k] === expected[k]);
    return { id: c.id, label: c.label, ok, expected, actual };
  });
}
