import type { PrismaService } from '../../prisma/prisma.service';

/** A manual booking with money still owed on it. All amounts are minor units. */
export interface OwedRow {
  id: string;
  venueId: string;
  code: string;
  customerName: string | null;
  courtName: string;
  slotStart: Date;
  slotEnd: Date;
  outstanding: number;
  currency: string;
}

const SIXTY_DAYS_MS = 60 * 86_400_000;

/**
 * Bookings that still owe money. `overdue` = already played (the owner is
 * chasing cash), `upcoming` = starting inside the window (the owner can collect
 * at the door). Shared by the chat ("فكرني"), the dashboard digest and the
 * push reminders, so all three always agree on who owes what.
 */
export async function findOwed(
  prisma: Pick<PrismaService, 'booking'>,
  scope: { venueId?: string },
  when:
    | { kind: 'overdue'; now: Date }
    | { kind: 'upcoming'; from: Date; to: Date },
): Promise<OwedRow[]> {
  const slot =
    when.kind === 'overdue'
      ? {
          slotEnd: { lt: when.now },
          slotStart: { gte: new Date(when.now.getTime() - SIXTY_DAYS_MS) },
        }
      : { slotStart: { gte: when.from, lt: when.to } };
  const rows = await prisma.booking.findMany({
    where: {
      ...(scope.venueId ? { venueId: scope.venueId } : {}),
      source: 'manual',
      status: { in: ['held', 'confirmed', 'completed'] },
      paymentStatus: { in: ['pending', 'partial'] },
      ...slot,
    },
    include: {
      court: { select: { name: true } },
      payments: { where: { status: 'paid' }, select: { amount: true } },
    },
    orderBy: { slotStart: 'asc' },
    take: 200,
  });
  return rows
    .map((b) => {
      const paid = b.payments.reduce((sum, p) => sum + p.amount, 0);
      return {
        id: b.id,
        venueId: b.venueId,
        code: b.code,
        customerName: b.guestName,
        courtName: b.court.name,
        slotStart: b.slotStart,
        slotEnd: b.slotEnd,
        outstanding: Math.max(0, b.totalAmount - paid),
        currency: b.currency,
      };
    })
    .filter((b) => b.outstanding > 0);
}
