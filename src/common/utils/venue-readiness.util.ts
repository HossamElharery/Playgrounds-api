import type { WeeklyHours } from './weekly-hours.util';
import { hasPricedHours, pricingGaps, type PricingGap } from './pricing-coverage.util';
import type { PricingRuleLike } from './pricing-rule.util';

export type BookingBlocker = 'hours' | 'courts' | 'prices' | 'location';

export interface ReadinessVenue {
  weeklyHours: unknown;
  lat: number;
  lng: number;
  address?: string | null;
}

export function hasOpeningHours(weeklyHours: unknown): boolean {
  if (!weeklyHours || typeof weeklyHours !== 'object') return false;
  return Object.values(weeklyHours as WeeklyHours).some((d) => !!d && !d.closed && !!d.open && !!d.close);
}

export function hasLocation(venue: Pick<ReadinessVenue, 'lat' | 'lng' | 'address'>): boolean {
  const placed = !(venue.lat === 0 && venue.lng === 0);
  return placed && (venue.address ?? '').trim().length > 0;
}

export type ReadinessRule = Pick<PricingRuleLike, 'daysOfWeek' | 'startTime' | 'endTime' | 'kind'>;

export function bookingBlockers(
  venue: ReadinessVenue,
  courts: Array<{ pricingRules: number; rules?: ReadinessRule[] }>,
): BookingBlocker[] {
  const missing: BookingBlocker[] = [];
  const hours = hasOpeningHours(venue.weeklyHours);
  if (!hours) missing.push('hours');
  if (courts.length === 0) missing.push('courts');
  else if (
    courts.some(
      (c) =>
        c.pricingRules === 0 ||
        (hours && c.rules && !hasPricedHours(c.rules, venue.weeklyHours as WeeklyHours)),
    )
  )
    missing.push('prices');
  if (!hasLocation(venue)) missing.push('location');
  return missing;
}

export function venuePricingGaps(
  weeklyHours: unknown,
  courts: Array<{ id: string; name: string; rules: ReadinessRule[] }>,
): Array<{ courtId: string; name: string; gaps: PricingGap[] }> {
  if (!hasOpeningHours(weeklyHours)) return [];
  return courts
    .map((c) => ({ courtId: c.id, name: c.name, gaps: pricingGaps(c.rules, weeklyHours as WeeklyHours) }))
    .filter((c) => c.gaps.length > 0);
}

export async function loadBookingBlockers(
  prisma: {
    venue: { findUnique(args: any): Promise<ReadinessVenue | null> };
    court: {
      findMany(
        args: any,
      ): Promise<Array<{ _count: { pricingRules: number }; pricingRules: ReadinessRule[] }>>;
    };
  },
  venueId: string,
): Promise<BookingBlocker[]> {
  const [venue, courts] = await Promise.all([
    prisma.venue.findUnique({ where: { id: venueId }, select: { weeklyHours: true, lat: true, lng: true, address: true } }),
    prisma.court.findMany({
      where: { venueId },
      select: {
        _count: { select: { pricingRules: true } },
        pricingRules: { select: { daysOfWeek: true, startTime: true, endTime: true, kind: true } },
      },
    }),
  ]);
  if (!venue) return ['hours', 'courts', 'prices', 'location'];
  return bookingBlockers(
    venue,
    courts.map((c) => ({ pricingRules: c._count.pricingRules, rules: c.pricingRules })),
  );
}
