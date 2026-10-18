import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertVenueAccess } from '../../../common/access/owner-access';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import type { WeeklyHours } from '../../../common/utils/weekly-hours.util';
import { bookingBlockers, venuePricingGaps, type BookingBlocker } from '../../../common/utils/venue-readiness.util';

export type VenueSection = 'hours' | 'units' | 'prices' | 'location' | 'details' | 'more';
const blockerSection: Record<BookingBlocker, VenueSection> = {
  hours: 'hours',
  courts: 'units',
  prices: 'prices',
  location: 'location',
};

export type QuickstartKey = 'hours' | 'courts' | 'prices' | 'team' | 'firstBooking' | 'import';

export type ReadinessKey = 'photos' | 'description' | 'address' | 'cancellation' | 'phone';

export interface ReadinessItem {
  key: ReadinessKey;
  done: boolean;
  level: 'required' | 'recommended';
  have?: number;
  want?: number;
  route: string;
}

export interface QuickstartStep {
  key: QuickstartKey;
  done: boolean;
  optional: boolean;
  route: string;
}

@Injectable()
export class QuickstartService {
  constructor(private readonly prisma: PrismaService) {}

  async forVenue(user: AuthenticatedUser, venueId: string) {
    const venue = await assertVenueAccess(this.prisma, user, venueId, { write: false });
    return this.compute(venue.id, venue.ownerId, venue.weeklyHours as WeeklyHours | null);
  }

  async compute(venueId: string, ownerId: string, weeklyHours: WeeklyHours | null) {
    const [courts, staff, anyBooking, venue, photos, imported] = await Promise.all([
      this.prisma.court.findMany({
        where: { venueId },
        select: {
          id: true,
          name: true,
          _count: { select: { pricingRules: true } },
          pricingRules: { select: { daysOfWeek: true, startTime: true, endTime: true, kind: true } },
        },
      }),
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
    const venuePage = `/owner/venues/${venueId}`;
    const section = (name: VenueSection) => `${venuePage}?section=${name}`;
    const gaps = venuePricingGaps(weeklyHours, courts.map((c) => ({ id: c.id, name: c.name, rules: c.pricingRules ?? [] })));
    const steps: QuickstartStep[] = [
      { key: 'hours', done: hoursSet, optional: false, route: section('hours') },
      { key: 'courts', done: courts.length > 0, optional: false, route: section('units') },
      { key: 'prices', done: courts.length > 0 && courts.every((c) => c._count.pricingRules > 0), optional: false, route: section('prices') },
      { key: 'team', done: staff > 0, optional: true, route: '/owner/staff' },
      { key: 'firstBooking', done: !!anyBooking, optional: false, route: '/owner/today' },
      { key: 'import', done: imported > 0, optional: true, route: '/owner/import' },
    ];
    const text = (v?: string | null) => (v ?? '').trim();
    const readinessItems: ReadinessItem[] = [
      { key: 'photos', done: photos >= 1, level: 'required', have: photos, want: 3, route: section('details') },
      { key: 'description', done: text(venue?.descriptionAr).length > 0 || text(venue?.descriptionEn).length > 0, level: 'recommended', route: section('details') },
      { key: 'address', done: text(venue?.address).length > 0 && !(venue?.lat === 0 && venue?.lng === 0), level: 'required', route: section('location') },
      { key: 'phone', done: text(venue?.contactPhone).length > 0, level: 'required', route: section('details') },
      { key: 'cancellation', done: text(venue?.cancellationPolicy).length > 0, level: 'recommended', route: section('details') },
    ];
    const photoItem = readinessItems[0];
    const weights = readinessItems.map((i) => (i.key === 'photos' ? Math.min(1, photos / (i.want ?? 3)) : i.done ? 1 : 0));
    const readiness = {
      items: readinessItems,
      score: Math.round((weights.reduce((a, b) => a + b, 0) / readinessItems.length) * 100),
      complete: readinessItems.every((i) => i.done) && photos >= (photoItem.want ?? 3),
    };
    const missing: BookingBlocker[] = venue
      ? bookingBlockers(
          { weeklyHours, lat: venue.lat, lng: venue.lng, address: venue.address },
          courts.map((c) => ({ pricingRules: c._count.pricingRules, rules: c.pricingRules ?? undefined })),
        )
      : ['hours', 'courts', 'prices', 'location'];
    return {
      steps,
      complete: steps.filter((s) => !s.optional).every((s) => s.done),
      readiness,
      bookable: {
        ready: missing.length === 0,
        missing,
        route: venuePage,
        routes: Object.fromEntries(missing.map((m) => [m, section(blockerSection[m])])),
        pricingGaps: gaps,
      },
    };
  }
}
