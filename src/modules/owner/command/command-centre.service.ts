import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { loadStaffScope, scopeCan } from '../../../common/access/staff-scope';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { resolveOwnerRange } from '../../../common/utils/owner-range.util';
import { loadBookingBlockers, type BookingBlocker } from '../../../common/utils/venue-readiness.util';
import { PrismaService } from '../../prisma/prisma.service';
import { findAllOwed } from '../assistant/assistant-attention';
import { COUNTED_PAYMENT_STATUSES } from '../cash/payment-trail';
import { OwnerSummaryService } from '../owner-summary.service';

export interface CommandVenue {
  id: string;
  nameAr: string;
  nameEn: string;
  status: string;
  currency: string;
  timezone: string;
  todayBookings: number;
  receivedToday: number;
  owed: { overdue: number; overdueCount: number; upcoming: number; upcomingCount: number };
  drawers: { open: number; handovers: number; toReview: number } | null;
  blockers: BookingBlocker[];
  attention: number;
}

@Injectable()
export class CommandCentreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly summary: OwnerSummaryService,
  ) {}

  async centre(user: AuthenticatedUser) {
    const { venueFilter, canReviewShifts } = await this.scopeOf(user);
    const venues = await this.prisma.venue.findMany({
      where: venueFilter,
      select: { id: true, nameAr: true, nameEn: true, status: true, currency: true, country: { select: { timezone: true } } },
      orderBy: { nameEn: 'asc' },
      take: 50,
    });
    const rows = await Promise.all(venues.map((v) => this.venueRow(v, canReviewShifts)));
    rows.sort((a, b) => b.attention - a.attention || a.nameEn.localeCompare(b.nameEn));

    const totals = new Map<string, { currency: string; receivedToday: number; owed: number }>();
    for (const r of rows) {
      const t = totals.get(r.currency) ?? { currency: r.currency, receivedToday: 0, owed: 0 };
      t.receivedToday += r.receivedToday;
      t.owed += r.owed.overdue + r.owed.upcoming;
      totals.set(r.currency, t);
    }
    return {
      generatedAt: new Date().toISOString(),
      venues: rows,
      totalsByCurrency: [...totals.values()],
      needAttention: rows.filter((r) => r.attention > 0).length,
    };
  }

  private async scopeOf(user: AuthenticatedUser): Promise<{ venueFilter: Prisma.VenueWhereInput; canReviewShifts: boolean }> {
    if (user.roles.includes('owner') || user.roles.includes('admin')) {
      return { venueFilter: { ownerId: user.id }, canReviewShifts: true };
    }
    const scope = await loadStaffScope(this.prisma, user.id);
    if (!scope || !scopeCan(scope, 'bookings.view') || !scopeCan(scope, 'reports.view')) throw new ForbiddenException('Not allowed');
    return {
      venueFilter: { ownerId: scope.ownerId, id: { in: scope.venueIds } },
      canReviewShifts: scopeCan(scope, 'shifts.review'),
    };
  }

  private async venueRow(
    v: { id: string; nameAr: string; nameEn: string; status: string; currency: string; country: { timezone: string } },
    canReviewShifts: boolean,
  ): Promise<CommandVenue> {
    const tz = v.country.timezone;
    const { start, end } = resolveOwnerRange('today', tz);
    const [todayBookings, cashbook, owed, blockers, drawers] = await Promise.all([
      this.prisma.booking.count({
        where: { venueId: v.id, slotStart: { gte: start, lt: end }, status: { in: ['held', 'confirmed', 'completed'] } },
      }),
      this.summary.cashbook(v.id, start, end),
      findAllOwed(this.prisma, v.id),
      loadBookingBlockers(this.prisma as never, v.id),
      canReviewShifts ? this.drawers(v.id) : Promise.resolve(null),
    ]);
    const sum = (rows: Array<{ outstanding: number }>) => rows.reduce((s, r) => s + r.outstanding, 0);
    const row: CommandVenue = {
      id: v.id,
      nameAr: v.nameAr,
      nameEn: v.nameEn,
      status: v.status,
      currency: v.currency,
      timezone: tz,
      todayBookings,
      receivedToday: cashbook.received,
      owed: {
        overdue: sum(owed.overdue),
        overdueCount: owed.overdue.length,
        upcoming: sum(owed.upcoming),
        upcomingCount: owed.upcoming.length,
      },
      drawers,
      blockers,
      attention: 0,
    };
    row.attention = attentionScore(row);
    return row;
  }

  private async drawers(venueId: string) {
    const [openPeople, handovers, toReview] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['recordedByUserId'],
        where: { shiftId: null, status: { in: COUNTED_PAYMENT_STATUSES }, recordedByUserId: { not: null }, OR: [{ booking: { venueId } }, { gamingOrder: { venueId } }] },
      }),
      this.prisma.cashHandover.count({ where: { venueId, shiftId: null } }),
      this.prisma.cashShift.count({ where: { venueId, reviewedAt: null, difference: { not: 0 } } }),
    ]);
    return { open: openPeople.length, handovers, toReview };
  }
}

export function attentionScore(v: Pick<CommandVenue, 'owed' | 'drawers' | 'blockers'> & { status?: string }): number {
  if (v.status && v.status !== 'active') return 0;
  return (
    (v.blockers.length ? 3 : 0) +
    (v.owed.overdueCount > 0 ? 2 : 0) +
    (v.drawers && v.drawers.toReview > 0 ? 2 : 0) +
    (v.drawers && v.drawers.open > 0 ? 1 : 0)
  );
}
