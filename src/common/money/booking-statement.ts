/**
 * The one statement the owner reads for a booking: what the slot cost, who paid for each
 * discount, what the venue is owed, and how much of it has actually been received.
 * Pure module (no Nest / Prisma). All amounts are integer minor units.
 *
 * Every owner screen that shows a booking's money (the booking sheet, the lists, the exports)
 * is built from this, so the same booking can never read two different ways.
 */

export interface StatementBooking {
  /** A cancelled booking owes nothing — whatever was kept is income, not a debt. */
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

/** Stable keys: the UI maps each to a label, the exports to a column. */
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
  /** Always >= 0; `kind` carries the sign (minus lines are shown with a leading −). */
  amount: number;
}

export interface BookingStatement {
  currency: string;
  /** Matchena bookings pay a commission and may carry discounts; the venue's own do not. */
  kind: 'platform' | 'manual';
  /** Price of the slot before any discount. */
  listPrice: number;
  /** Discount the VENUE absorbs (a venue promo / package). Reduces what the venue is owed. */
  ownerDiscount: number;
  /** Discount Matchena absorbs (coins, global promo). The player got it; the venue loses nothing. */
  platformDiscount: number;
  /** Service fee the player paid to Matchena. Never the venue's money. */
  customerFee: number;
  /** What the customer is charged in total. */
  customerTotal: number;
  /** What the venue is owed for the slot before Matchena's commission. */
  venueGross: number;
  commissionBps: number;
  commission: number;
  /** What the venue keeps after the commission. */
  ownerNet: number;
  /** Net money received so far (payments minus refunds). */
  received: number;
  /** What the customer still owes the venue / Matchena. */
  outstanding: number;
  /** Money handed back to the customer (always >= 0). */
  refunded: number;
  lines: StatementLine[];
}

const nz = (n: number | null | undefined) => (Number.isFinite(n as number) ? (n as number) : 0);

/**
 * @param received net of every counted payment (refunds are negative rows)
 * @param refunded total handed back, as a positive number
 */
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
