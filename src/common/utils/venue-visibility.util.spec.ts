import { ConflictException } from '@nestjs/common';
import {
  assertVenueBookable,
  computeVenueState,
  publicVenueWhere,
  type VenueStateInput,
} from './venue-visibility.util';

const live: VenueStateInput = {
  status: 'active',
  ownerListingEnabled: true,
  adminHidden: false,
  instantBook: true,
  operationsEnabled: true,
};

describe('venue visibility policy', () => {
  it('shows and books a venue that is approved, listed, not hidden and accepting bookings', () => {
    expect(computeVenueState(live)).toMatchObject({
      listing: 'visible',
      publicVisible: true,
      booking: 'bookable',
      bookable: true,
      lockedByAdmin: false,
    });
  });

  it.each([
    ['pending approval', { status: 'pending' }, 'pending_approval', false],
    ['suspended by admin', { status: 'suspended' }, 'suspended_by_admin', true],
    ['hidden by admin', { adminHidden: true }, 'hidden_by_admin', true],
    ['hidden by the owner', { ownerListingEnabled: false }, 'hidden_by_owner', false],
  ] as const)('%s is not public and not bookable', (_name, patch, listing, locked) => {
    const state = computeVenueState({ ...live, ...patch });
    expect(state.listing).toBe(listing);
    expect(state.publicVisible).toBe(false);
    expect(state.booking).toBe('not_listed');
    expect(state.bookable).toBe(false);
    expect(state.lockedByAdmin).toBe(locked);
  });

  it('keeps a venue listed but closed to new bookings when the owner pauses booking acceptance', () => {
    const state = computeVenueState({ ...live, instantBook: false });
    expect(state).toMatchObject({ publicVisible: true, booking: 'bookings_paused', bookable: false });
  });

  it('reports a venue that is not ready as not public, with the missing items', () => {
    const state = computeVenueState(live, ['hours', 'prices']);
    expect(state).toMatchObject({ listing: 'not_ready', publicVisible: false, missing: ['hours', 'prices'] });
  });

  it('never lets the owner preference or the booking switch outrank an admin decision', () => {
    for (const adminState of [{ status: 'suspended' as const }, { adminHidden: true }]) {
      const state = computeVenueState({ ...live, ...adminState, ownerListingEnabled: true, instantBook: true });
      expect(state.publicVisible).toBe(false);
      expect(state.bookable).toBe(false);
    }
  });

  it('keeps the operations switch out of visibility and booking', () => {
    const state = computeVenueState({ ...live, operationsEnabled: false });
    expect(state).toMatchObject({ publicVisible: true, bookable: true, operationsPaused: true });
  });

  it('builds the Prisma filter every public query shares', () => {
    expect(publicVenueWhere()).toEqual({ status: 'active', ownerListingEnabled: true, adminHidden: false });
  });

  describe('assertVenueBookable', () => {
    it('passes for a bookable venue', () => {
      expect(() => assertVenueBookable(live)).not.toThrow();
    });
    it.each([
      [{ status: 'suspended' as const }, 'VENUE_UNAVAILABLE'],
      [{ adminHidden: true }, 'VENUE_UNAVAILABLE'],
      [{ ownerListingEnabled: false }, 'VENUE_UNAVAILABLE'],
      [{ instantBook: false }, 'VENUE_BOOKING_DISABLED'],
    ])('throws a stable code for %j', (patch, code) => {
      try {
        assertVenueBookable({ ...live, ...patch });
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({ code });
      }
    });
    it('names the missing set-up items when the venue is not ready', () => {
      try {
        assertVenueBookable(live, ['courts']);
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'VENUE_NOT_READY',
          missing: ['courts'],
        });
      }
    });
  });
});
