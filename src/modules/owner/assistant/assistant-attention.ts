import type { PrismaService } from '../../prisma/prisma.service';

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

export async function findOwed(
  prisma: Pick<PrismaService, 'booking'>,
  scope: { venueId?: string },
  when:
    | { kind: 'overdue'; now: Date }
    | { kind: 'upcoming'; from: Date; to: Date; includeSettled?: boolean }
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
      ...(when.kind === 'upcoming' && when.includeSettled ? {} : { paymentStatus: { in: ['pending', 'partial'] as ('pending' | 'partial')[] } }),
      ...slot,
    },
    include: {
      court: { select: { name: true } },
      payments: { where: { status: { in: ['paid', 'refunded'] } }, select: { amount: true } },
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
    .filter((b) => (when.kind === 'upcoming' && when.includeSettled) || b.outstanding > 0);
}

const UPCOMING_DAYS = 30;

export async function findAllOwed(
  prisma: Pick<PrismaService, 'booking'>,
  venueId: string,
  now: Date = new Date(),
): Promise<{ overdue: OwedRow[]; upcoming: OwedRow[] }> {
  const [overdue, upcoming] = await Promise.all([
    findOwed(prisma, { venueId }, { kind: 'overdue', now }),
    findOwed(prisma, { venueId }, { kind: 'ahead', now, to: new Date(now.getTime() + UPCOMING_DAYS * 86_400_000) }),
  ]);
  return { overdue, upcoming };
}
