import type { WeeklyHours } from './weekly-hours.util';
import { hasPricedHours, pricingGaps, type PricingGap } from './pricing-coverage.util';
import type { PricingRuleLike } from './pricing-rule.util';

/**
 * What a venue must have before anyone can book it. Without opening hours the system
 * used to treat the venue as open 24 hours, so a half-set-up venue showed an empty
 * night as bookable. "No hours" now means "not bookable", never "always open".
 */
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

/**
 * The things still missing before players can book. Empty list = bookable. Pure.
 * `rules` (when given) lets "prices" also mean "the price list misses every hour the venue is open";
 * a partial gap is not a blocker — it is a warning (`venuePricingGaps`).
 */
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

/** Hours of a court that no everyday price covers, per court — what to fix, in the owner's words. */
export function venuePricingGaps(
  weeklyHours: unknown,
  courts: Array<{ id: string; name: string; rules: ReadinessRule[] }>,
): Array<{ courtId: string; name: string; gaps: PricingGap[] }> {
  if (!hasOpeningHours(weeklyHours)) return [];
  return courts
    .map((c) => ({ courtId: c.id, name: c.name, gaps: pricingGaps(c.rules, weeklyHours as WeeklyHours) }))
    .filter((c) => c.gaps.length > 0);
}

/** Loads what `bookingBlockers` needs for one venue. Shared by the admin approval and the owner checklist. */
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
