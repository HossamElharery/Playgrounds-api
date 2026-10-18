
export interface StatementBooking {
  status?: string;
  source: 'platform' | 'manual';
  baseAmount: number;
  feeAmount: number;
  discountAmount: number;
  totalAmount: number;
  ownerFundedDiscount: number;
  commissionBps: number | null;
  commissionAmount: number | null;
  ownerNetAmount: number | null;
  currency: string;
}

export type StatementLineKey =
  | 'listPrice'
  | 'ownerDiscount'
  | 'venueGross'
  | 'commission'
  | 'ownerNet';

export type StatementLineKind = 'plus' | 'minus' | 'subtotal' | 'total';

export interface StatementLine {
  key: StatementLineKey;
  kind: StatementLineKind;
  amount: number;
}

export interface BookingStatement {
  currency: string;
  kind: 'platform' | 'manual';
  listPrice: number;
  ownerDiscount: number;
  platformDiscount: number;
  customerFee: number;
  customerTotal: number;
  venueGross: number;
  commissionBps: number;
  commission: number;
  ownerNet: number;
  received: number;
  outstanding: number;
  refunded: number;
  lines: StatementLine[];
}

const nz = (n: number | null | undefined) => (Number.isFinite(n as number) ? (n as number) : 0);

export function buildBookingStatement(
  b: StatementBooking,
  received: number,
  refunded = 0,
): BookingStatement {
  const platform = b.source === 'platform';
  const listPrice = nz(b.baseAmount);
  const ownerDiscount = platform ? Math.min(listPrice, nz(b.ownerFundedDiscount)) : 0;
  const platformDiscount = platform ? Math.max(0, nz(b.discountAmount) - ownerDiscount) : 0;
  const customerFee = platform ? nz(b.feeAmount) : 0;
  const customerTotal = nz(b.totalAmount);
  const venueGross = platform ? Math.max(0, listPrice - ownerDiscount) : customerTotal;
  const commission = platform ? nz(b.commissionAmount) : 0;
  const ownerNet = platform ? nz(b.ownerNetAmount ?? venueGross - commission) : customerTotal;

  const lines: StatementLine[] = [{ key: 'listPrice', kind: 'plus', amount: platform ? listPrice : customerTotal }];
  if (platform) {
    if (ownerDiscount > 0) {
      lines.push({ key: 'ownerDiscount', kind: 'minus', amount: ownerDiscount });
      lines.push({ key: 'venueGross', kind: 'subtotal', amount: venueGross });
    }
    lines.push({ key: 'commission', kind: 'minus', amount: commission });
    lines.push({ key: 'ownerNet', kind: 'total', amount: ownerNet });
  }

  return {
    currency: b.currency,
    kind: b.source,
    listPrice: platform ? listPrice : customerTotal,
    ownerDiscount,
    platformDiscount,
    customerFee,
    customerTotal,
    venueGross,
    commissionBps: platform ? nz(b.commissionBps) : 0,
    commission,
    ownerNet,
    received,
    outstanding: b.status === 'cancelled' ? 0 : Math.max(0, customerTotal - received),
    refunded: Math.max(0, refunded),
    lines,
  };
}
