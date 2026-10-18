import { PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';

export const COUNTED_PAYMENT_STATUSES: PaymentStatus[] = ['paid', 'refunded'];

export interface NetReceived {
  received: number;
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

export function derivePaymentStatus(total: number, received: number): PaymentStatus {
  if (received >= total) return 'paid';
  if (received > 0) return 'partial';
  return 'pending';
}

export const DRAWER_METHODS: PaymentMethod[] = ['cash'];

export const isCashMethod = (m: PaymentMethod | string): boolean => m === 'cash';
