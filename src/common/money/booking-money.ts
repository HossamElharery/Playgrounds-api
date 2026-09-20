/**
 * Single source of truth for booking money math.
 * Pure module: no Nest / Prisma imports. All amounts are integer minor units.
 *
 * Rounding: round-half-up on the real line (0.5 → 1, -0.5 → -1).
 */

export const DEFAULT_COMMISSION_BPS = 1000;
export const MIN_COMMISSION_BPS = 0;
export const MAX_COMMISSION_BPS = 5000;

export class MoneyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyInputError';
  }
}

export interface BookingMoneyInput {
  base: number;
  fee: number;
  discount: number;
  ownerFundedDiscount: number;
  commissionBps: number;
}

export interface BookingMoney {
  base: number;
  fee: number;
  discount: number;
  total: number;
  ownerFundedDiscount: number;
  platformFundedDiscount: number;
  ownerGross: number;
  commissionBps: number;
  commissionAmount: number;
  ownerNet: number;
  platformTake: number;
}

export type BookingSourceKind = 'platform' | 'manual';
export type VenuePaymentModeKind = 'at_venue' | 'online';
export type BookingStatusKind =
  | 'held'
  | 'confirmed'
  | 'cancelled'
  | 'completed'
  | 'no_show';
export type PaymentStatusKind =
  | 'pending'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'partial';

export interface LedgerBookingState {
  source: BookingSourceKind;
  paymentMode: VenuePaymentModeKind;
  status: BookingStatusKind;
  paymentStatus: PaymentStatusKind;
  checkedInAt: Date | string | null;
  money: Pick<BookingMoney, 'ownerNet' | 'total'>;
}

function assertInt(n: number, name: string): void {
  if (typeof n !== 'number' || Number.isNaN(n) || !Number.isFinite(n)) {
    throw new MoneyInputError(`${name} must be a finite number`);
  }
  if (!Number.isInteger(n)) {
    throw new MoneyInputError(`${name} must be an integer`);
  }
}

function assertNonNegativeInt(n: number, name: string): void {
  assertInt(n, name);
  if (n < 0) throw new MoneyInputError(`${name} must be >= 0`);
}

/** Round half up for both signs: 33.5 → 34, -33.5 → -34, 33.3 → 33. */
export function roundHalfUp(n: number): number {
  if (typeof n !== 'number' || Number.isNaN(n) || !Number.isFinite(n)) {
    throw new MoneyInputError('roundHalfUp requires a finite number');
  }
  return n >= 0 ? Math.floor(n + 0.5) : Math.ceil(n - 0.5);
}

export function computeCommission(ownerGross: number, bps: number): number {
  assertNonNegativeInt(ownerGross, 'ownerGross');
  assertInt(bps, 'commissionBps');
  if (bps < MIN_COMMISSION_BPS || bps > MAX_COMMISSION_BPS) {
    throw new MoneyInputError(
      `commissionBps must be between ${MIN_COMMISSION_BPS} and ${MAX_COMMISSION_BPS}`,
    );
  }
  return roundHalfUp((ownerGross * bps) / 10_000);
}

export function computeBookingMoney(i: BookingMoneyInput): BookingMoney {
  assertNonNegativeInt(i.base, 'base');
  assertNonNegativeInt(i.fee, 'fee');
  assertNonNegativeInt(i.discount, 'discount');
  assertNonNegativeInt(i.ownerFundedDiscount, 'ownerFundedDiscount');
  assertInt(i.commissionBps, 'commissionBps');
  if (i.commissionBps < MIN_COMMISSION_BPS || i.commissionBps > MAX_COMMISSION_BPS) {
    throw new MoneyInputError(
      `commissionBps must be between ${MIN_COMMISSION_BPS} and ${MAX_COMMISSION_BPS}`,
    );
  }
  if (i.ownerFundedDiscount > i.base) {
    throw new MoneyInputError('ownerFundedDiscount cannot exceed base');
  }
  if (i.ownerFundedDiscount > i.discount) {
    throw new MoneyInputError('ownerFundedDiscount cannot exceed discount');
  }

  const total = Math.max(0, i.base + i.fee - i.discount);
  const platformFundedDiscount = i.discount - i.ownerFundedDiscount;
  const ownerGross = Math.max(0, i.base - i.ownerFundedDiscount);
  const commissionAmount = computeCommission(ownerGross, i.commissionBps);
  const ownerNet = ownerGross - commissionAmount;
  const platformTake = total - ownerNet;

  return {
    base: i.base,
    fee: i.fee,
    discount: i.discount,
    total,
    ownerFundedDiscount: i.ownerFundedDiscount,
    platformFundedDiscount,
    ownerGross,
    commissionBps: i.commissionBps,
    commissionAmount,
    ownerNet,
    platformTake,
  };
}

export function bookingSnapshotFields(money: BookingMoney, paymentMode: VenuePaymentModeKind) {
  return {
    source: 'platform' as const,
    paymentModeSnapshot: paymentMode,
    ownerFundedDiscount: money.ownerFundedDiscount,
    commissionBps: money.commissionBps,
    commissionAmount: money.commissionAmount,
    ownerNetAmount: money.ownerNet,
  };
}

/**
 * Desired signed delta on the venue ledger (Matchena owes owner).
 * Rules: MATCHENA_OWNER_PLATFORM_PROMPTS/00_README_MASTER_CONTEXT.md §4.
 */
export function desiredLedgerDelta(s: LedgerBookingState): number {
  if (s.source === 'manual') return 0;

  const { ownerNet, total } = s.money;
  const cancelled = s.status === 'cancelled';

  if (s.paymentMode === 'online') {
    if (
      cancelled ||
      s.paymentStatus === 'refunded' ||
      s.paymentStatus === 'failed' ||
      s.paymentStatus === 'pending' ||
      s.paymentStatus === 'partial'
    ) {
      return 0;
    }
    if (
      s.paymentStatus === 'paid' &&
      (s.status === 'confirmed' ||
        s.status === 'completed' ||
        s.status === 'no_show')
    ) {
      return ownerNet;
    }
    return 0;
  }

  // at_venue: accrues when the owner has the cash (checked in / completed).
  if (cancelled) return 0;
  const checkedIn = s.checkedInAt != null;
  if (s.status === 'completed' || (checkedIn && s.status !== 'cancelled')) {
    return ownerNet - total;
  }
  return 0;
}
