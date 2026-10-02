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
  totalAmount: number;
  paidAmount: number;
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
    | { kind: 'upcoming'; from: Date; to: Date }
    /** Not finished yet: playing now or still to come, up to `to`. */
    | { kind: 'ahead'; now: Date; to: Date },
): Promise<OwedRow[]> {
  const slot =
    when.kind === 'overdue'
      ? {
          slotEnd: { lt: when.now },
          slotStart: { gte: new Date(when.now.getTime() - SIXTY_DAYS_MS) },
        }
      : when.kind === 'ahead'
        ? { slotEnd: { gte: when.now }, slotStart: { lt: when.to } }
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
        totalAmount: b.totalAmount,
        paidAmount: paid,
        currency: b.currency,
      };
    })
    .filter((b) => b.outstanding > 0);
}

const UPCOMING_DAYS = 30;

/**
 * Everything the venue is owed, in one place: finished bookings that were never paid in full,
 * and bookings still to come that already carry a balance. "Who owes me?" in the chat, the
 * dashboard digest and the push reminders all read this — a question must never answer
 * "nobody owes you" while the reminder next to it lists a debt.
 */
export async function findAllOwed(
  prisma: Pick<PrismaService, 'booking'>,
  venueId: string,
  now: Date = new Date(),
): Promise<{ overdue: OwedRow[]; upcoming: OwedRow[] }> {
  const [overdue, upcoming] = await Promise.all([
    findOwed(prisma, { venueId }, { kind: 'overdue', now }),
    // `ahead` includes a game being played right now, which is neither finished nor yet to start.
    findOwed(prisma, { venueId }, { kind: 'ahead', now, to: new Date(now.getTime() + UPCOMING_DAYS * 86_400_000) }),
  ]);
  return { overdue, upcoming };
}
