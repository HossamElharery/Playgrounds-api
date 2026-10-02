import { PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';

/**
 * Payment rows that count as money actually moved. A payment taken back is never deleted: it is
 * answered by a negative `refunded` row, so summing both gives the net received and a closed
 * cash shift can never be rewritten behind the owner's back.
 */
export const COUNTED_PAYMENT_STATUSES: PaymentStatus[] = ['paid', 'refunded'];

export interface NetReceived {
  /** Payments minus refunds. */
  received: number;
  /** Total handed back, as a positive number. */
  refunded: number;
}

export function netOf(rows: { amount: number }[]): NetReceived {
  let received = 0;
  let refunded = 0;
  for (const r of rows) {
    received += r.amount;
    if (r.amount < 0) refunded += -r.amount;
  }
  return { received, refunded };
}

export async function netReceived(
  db: Pick<Prisma.TransactionClient, 'payment'>,
  bookingId: string,
): Promise<NetReceived> {
  return netOf(
    await db.payment.findMany({
      where: { bookingId, status: { in: COUNTED_PAYMENT_STATUSES } },
      select: { amount: true },
    }),
  );
}

/** The booking's payment status, always derived from what was really received. */
export function derivePaymentStatus(total: number, received: number): PaymentStatus {
  if (received >= total) return 'paid';
  if (received > 0) return 'partial';
  return 'pending';
}

/** Methods that are cash in the drawer; everything else (InstaPay, wallet, card…) is not counted by hand. */
export const DRAWER_METHODS: PaymentMethod[] = ['cash'];

export const isCashMethod = (m: PaymentMethod | string): boolean => m === 'cash';
