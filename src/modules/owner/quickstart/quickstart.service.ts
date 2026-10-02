import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertVenueAccess } from '../../../common/access/owner-access';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import type { WeeklyHours } from '../../../common/utils/weekly-hours.util';

export type QuickstartKey = 'hours' | 'courts' | 'prices' | 'team' | 'firstBooking' | 'import';

export type ReadinessKey = 'photos' | 'description' | 'address' | 'cancellation' | 'phone';

export interface ReadinessItem {
  key: ReadinessKey;
  done: boolean;
  /** `required` is what a public page cannot look serious without; `recommended` is what makes it convincing. */
  level: 'required' | 'recommended';
  /** How many there are / how many we want, for things that are counted (photos). */
  have?: number;
  want?: number;
  route: string;
}

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
    const [courts, staff, anyBooking, venue, photos, imported] = await Promise.all([
      this.prisma.court.findMany({ where: { venueId }, select: { id: true, _count: { select: { pricingRules: true } } } }),
      this.prisma.staffMember.count({ where: { ownerId, OR: [{ venueIds: { has: venueId } }, { venueIds: { isEmpty: true } }] } }),
      this.prisma.booking.findFirst({ where: { venueId, status: { not: 'cancelled' } }, select: { id: true } }),
      this.prisma.venue.findUnique({
        where: { id: venueId },
        select: { descriptionAr: true, descriptionEn: true, address: true, lat: true, lng: true, cancellationPolicy: true, contactPhone: true },
      }),
      this.prisma.venuePhoto.count({ where: { venueId } }),
      this.prisma.venueImportBatch.count({ where: { venueId, undoneAt: null } }),
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
      // Bringing the existing notebook in is optional, but it is what lets the venue stop keeping two books.
      { key: 'import', done: imported > 0, optional: true, route: '/owner/import' },
    ];
    const text = (v?: string | null) => (v ?? '').trim();
    const readinessItems: ReadinessItem[] = [
      { key: 'photos', done: photos >= 1, level: 'required', have: photos, want: 3, route: venuePage },
      { key: 'description', done: text(venue?.descriptionAr).length >= 20 || text(venue?.descriptionEn).length >= 20, level: 'required', route: venuePage },
      { key: 'address', done: text(venue?.address).length > 0 && !(venue?.lat === 0 && venue?.lng === 0), level: 'required', route: venuePage },
      { key: 'phone', done: text(venue?.contactPhone).length > 0, level: 'required', route: venuePage },
      { key: 'cancellation', done: text(venue?.cancellationPolicy).length > 0, level: 'recommended', route: venuePage },
    ];
    // Three photos are what make a page look real; one is enough to count as "not empty".
    const photoItem = readinessItems[0];
    const weights = readinessItems.map((i) => (i.key === 'photos' ? Math.min(1, photos / (i.want ?? 3)) : i.done ? 1 : 0));
    const readiness = {
      items: readinessItems,
      score: Math.round((weights.reduce((a, b) => a + b, 0) / readinessItems.length) * 100),
      complete: readinessItems.every((i) => i.done) && photos >= (photoItem.want ?? 3),
    };
    return { steps, complete: steps.filter((s) => !s.optional).every((s) => s.done), readiness };
  }
}
