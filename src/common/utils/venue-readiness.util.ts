import type { WeeklyHours } from './weekly-hours.util';

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

/** The things still missing before players can book. Empty list = bookable. Pure. */
export function bookingBlockers(venue: ReadinessVenue, courts: Array<{ pricingRules: number }>): BookingBlocker[] {
  const missing: BookingBlocker[] = [];
  if (!hasOpeningHours(venue.weeklyHours)) missing.push('hours');
  if (courts.length === 0) missing.push('courts');
  else if (courts.some((c) => c.pricingRules === 0)) missing.push('prices');
  if (!hasLocation(venue)) missing.push('location');
  return missing;
}

/** Loads what `bookingBlockers` needs for one venue. Shared by the admin approval and the owner checklist. */
export async function loadBookingBlockers(
  prisma: {
    venue: { findUnique(args: any): Promise<ReadinessVenue | null> };
    court: { findMany(args: any): Promise<Array<{ _count: { pricingRules: number } }>> };
  },
  venueId: string,
): Promise<BookingBlocker[]> {
  const [venue, courts] = await Promise.all([
    prisma.venue.findUnique({ where: { id: venueId }, select: { weeklyHours: true, lat: true, lng: true, address: true } }),
    prisma.court.findMany({ where: { venueId }, select: { _count: { select: { pricingRules: true } } } }),
  ]);
  if (!venue) return ['hours', 'courts', 'prices', 'location'];
  return bookingBlockers(venue, courts.map((c) => ({ pricingRules: c._count.pricingRules })));
}
