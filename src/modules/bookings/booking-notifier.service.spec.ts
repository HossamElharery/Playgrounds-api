import { bookingNoticeDedupKey, selectBookingRecipients } from './booking-notifier.service';

const staff = (userId: string, permissions: string[], venueIds: string[], ownerId = 'owner-1') => ({
  userId, permissions, venueIds, ownerId,
});

describe('who hears about a booking', () => {
  it('always includes the owner, with money', () => {
    expect(selectBookingRecipients({ ownerId: 'owner-1' }, [], 'v1')).toEqual([
      { userId: 'owner-1', seesMoney: true, isOwner: true },
    ]);
  });

  it('adds staff who can see bookings at this venue and only those', () => {
    const out = selectBookingRecipients(
      { ownerId: 'owner-1' },
      [
        staff('desk', ['bookings.view'], ['v1']),
        staff('other-venue', ['bookings.view'], ['v2']),
        staff('no-view', ['customers.view'], ['v1']),
        staff('other-org', ['bookings.view'], ['v1'], 'owner-2'),
      ],
      'v1',
    );
    expect(out.map((r) => r.userId)).toEqual(['owner-1', 'desk']);
  });

  it('shows amounts only to people with a money permission', () => {
    const out = selectBookingRecipients(
      { ownerId: 'owner-1' },
      [
        staff('desk', ['bookings.view'], ['v1']),
        staff('accounts', ['bookings.view', 'account.view'], ['v1']),
        staff('reports', ['bookings.view', 'reports.view'], ['v1']),
      ],
      'v1',
    );
    const money = Object.fromEntries(out.map((r) => [r.userId, r.seesMoney]));
    expect(money).toEqual({ 'owner-1': true, desk: false, accounts: true, reports: true });
  });

  it('never lists the owner twice even if they also appear as staff', () => {
    const out = selectBookingRecipients({ ownerId: 'owner-1' }, [staff('owner-1', ['bookings.view'], ['v1'])], 'v1');
    expect(out).toHaveLength(1);
    expect(out[0].isOwner).toBe(true);
  });

  it('builds a dedup key that is unique per kind, booking and recipient', () => {
    expect(bookingNoticeDedupKey('booking_confirmed', 'b1', 'u1')).toBe('booking-confirmed-owner:b1:u1');
    expect(bookingNoticeDedupKey('booking_cancelled', 'b1', 'u1')).toBe('booking-cancelled-owner:b1:u1');
    expect(bookingNoticeDedupKey('booking_confirmed', 'b1', 'u2')).not.toBe(bookingNoticeDedupKey('booking_confirmed', 'b1', 'u1'));
  });
});
