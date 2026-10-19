import { ConflictException } from '@nestjs/common';
import type { Prisma, VenueStatus } from '@prisma/client';
import type { BookingBlocker } from './venue-readiness.util';

/**
 * The one place that decides whether a venue is shown to the public and whether
 * it takes bookings. Every public query, SEO surface and booking endpoint goes
 * through here so Explore, search, the venue page, the sitemap and the hold
 * endpoint can never disagree.
 *
 *   publicVisible = status is active (admin approved, not suspended)
 *                   AND the platform has not hidden it (adminHidden)
 *                   AND the owner wants it listed (ownerListingEnabled)
 *                   AND it is ready (hours, courts, prices, location)
 *
 *   bookable      = publicVisible AND the owner accepts bookings (instantBook)
 *
 * `operationsEnabled` is deliberately NOT part of either: pausing the owner's
 * management system does not unlist the venue.
 */
export interface VenueStateInput {
  status: VenueStatus;
  ownerListingEnabled: boolean;
  adminHidden: boolean;
  instantBook: boolean;
  operationsEnabled: boolean;
}

export type VenueListingState =
  | 'visible'
  | 'pending_approval'
  | 'suspended_by_admin'
  | 'hidden_by_admin'
  | 'hidden_by_owner'
  | 'not_ready';

export type VenueBookingState =
  | 'bookable'
  | 'not_listed'
  | 'bookings_paused';

export interface VenueEffectiveState {
  listing: VenueListingState;
  publicVisible: boolean;
  booking: VenueBookingState;
  bookable: boolean;
  operationsPaused: boolean;
  /** Missing set-up items when the owner/admin asks to publish a venue that is not ready. */
  missing: BookingBlocker[];
  /** True when only the platform can change the current state. */
  lockedByAdmin: boolean;
}

/**
 * Prisma filter for every public discovery query (Explore, search, sport and
 * area pages, sitemap, similar venues, Captain). Readiness is enforced when a
 * venue is published or re-listed, so it is not repeated per query.
 */
export function publicVenueWhere(): Prisma.VenueWhereInput {
  return { status: 'active', ownerListingEnabled: true, adminHidden: false };
}

export function computeVenueState(
  venue: VenueStateInput,
  missing: BookingBlocker[] = [],
): VenueEffectiveState {
  let listing: VenueListingState = 'visible';
  if (venue.status === 'pending') listing = 'pending_approval';
  else if (venue.status === 'suspended') listing = 'suspended_by_admin';
  else if (venue.adminHidden) listing = 'hidden_by_admin';
  else if (!venue.ownerListingEnabled) listing = 'hidden_by_owner';
  else if (missing.length > 0) listing = 'not_ready';

  const publicVisible = listing === 'visible';
  const booking: VenueBookingState = !publicVisible
    ? 'not_listed'
    : venue.instantBook
      ? 'bookable'
      : 'bookings_paused';
  return {
    listing,
    publicVisible,
    booking,
    bookable: booking === 'bookable',
    operationsPaused: venue.operationsEnabled === false,
    missing,
    lockedByAdmin: listing === 'suspended_by_admin' || listing === 'hidden_by_admin',
  };
}

/**
 * Throws the stable error the clients translate. Used by the slot grid, hold
 * and confirm so a venue hidden or paused between Hold and Confirm cannot
 * still be booked.
 */
export function assertVenueBookable(
  venue: VenueStateInput,
  missing: BookingBlocker[] = [],
): void {
  const state = computeVenueState(venue, missing);
  if (state.bookable) return;
  if (state.booking === 'bookings_paused') {
    throw new ConflictException({
      code: 'VENUE_BOOKING_DISABLED',
      message: 'This venue is not accepting online bookings right now',
    });
  }
  if (state.listing === 'not_ready') {
    throw new ConflictException({
      code: 'VENUE_NOT_READY',
      message: 'This venue is not ready for bookings yet',
      missing: state.missing,
    });
  }
  throw new ConflictException({
    code: 'VENUE_UNAVAILABLE',
    message: 'This venue is not accepting bookings right now',
  });
}

/** Counts the future bookings an owner would leave behind by hiding a venue. */
export const FUTURE_LIVE_BOOKING_STATUSES = ['held', 'confirmed'] as const;

/** Moderation and owner-control columns that only the owner and platform admins may see. */
const INTERNAL_VENUE_FIELDS = [
  'ownerListingEnabled',
  'adminHidden',
  'operationsEnabled',
  'moderationReason',
  'moderatedById',
  'moderatedAt',
  'listingChangedById',
  'listingChangedAt',
] as const;

export function withoutInternalVenueFields<T extends object>(venue: T): Omit<T, (typeof INTERNAL_VENUE_FIELDS)[number]> {
  const copy = { ...venue } as Record<string, unknown>;
  for (const key of INTERNAL_VENUE_FIELDS) delete copy[key];
  return copy as Omit<T, (typeof INTERNAL_VENUE_FIELDS)[number]>;
}


/** Prisma filter for "venues whose listing state is X" (readiness is not part of a list filter). */
export function venueListingWhere(
  listing: 'visible' | 'hidden_by_owner' | 'hidden_by_admin' | 'suspended_by_admin' | 'pending_approval',
): Prisma.VenueWhereInput {
  switch (listing) {
    case 'visible':
      return publicVenueWhere();
    case 'hidden_by_owner':
      return { status: 'active', adminHidden: false, ownerListingEnabled: false };
    case 'hidden_by_admin':
      return { status: 'active', adminHidden: true };
    case 'suspended_by_admin':
      return { status: 'suspended' };
    case 'pending_approval':
      return { status: 'pending' };
  }
}
