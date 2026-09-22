import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertVenueAccess } from '../../../common/access/owner-access';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import type { WeeklyHours } from '../../../common/utils/weekly-hours.util';

export type QuickstartKey = 'hours' | 'courts' | 'prices' | 'team' | 'firstBooking';

export interface QuickstartStep {
  key: QuickstartKey;
  done: boolean;
  optional: boolean;
  /** Owner-app route to open for this step. */
  route: string;
}

/**
 * The new-owner checklist. Every step is derived from real data (never a flag someone can
 * forget to set), so it also tells the admin honestly who is still stuck.
 */
@Injectable()
export class QuickstartService {
  constructor(private readonly prisma: PrismaService) {}

  async forVenue(user: AuthenticatedUser, venueId: string) {
    const venue = await assertVenueAccess(this.prisma, user, venueId, { write: false });
    return this.compute(venue.id, venue.ownerId, venue.weeklyHours as WeeklyHours | null);
  }

  /** Same computation without an actor — used by the admin health board. */
  async compute(venueId: string, ownerId: string, weeklyHours: WeeklyHours | null) {
    const [courts, staff, anyBooking] = await Promise.all([
      this.prisma.court.findMany({ where: { venueId }, select: { id: true, _count: { select: { pricingRules: true } } } }),
      this.prisma.staffMember.count({ where: { ownerId, OR: [{ venueIds: { has: venueId } }, { venueIds: { isEmpty: true } }] } }),
      this.prisma.booking.findFirst({ where: { venueId, status: { not: 'cancelled' } }, select: { id: true } }),
    ]);
    const hoursSet = !!weeklyHours && Object.values(weeklyHours).some((d) => d && !d.closed && d.open && d.close);
    // Hours, courts and prices are all edited on the venue's own management page
    // (`/owner/venues/:id`) — there is no separate screen for any of them.
    const venuePage = `/owner/venues/${venueId}`;
    const steps: QuickstartStep[] = [
      { key: 'hours', done: hoursSet, optional: false, route: venuePage },
      { key: 'courts', done: courts.length > 0, optional: false, route: venuePage },
      { key: 'prices', done: courts.length > 0 && courts.every((c) => c._count.pricingRules > 0), optional: false, route: venuePage },
      { key: 'team', done: staff > 0, optional: true, route: '/owner/staff' },
      { key: 'firstBooking', done: !!anyBooking, optional: false, route: '/owner/today' },
    ];
    return { steps, complete: steps.filter((s) => !s.optional).every((s) => s.done) };
  }
}
