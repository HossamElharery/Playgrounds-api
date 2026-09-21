import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { assertBookingAccess, assertVenueAccess } from './owner-access';
import { ApiException } from '../errors/api-exception';
import type { AuthenticatedUser } from '../types/authenticated-user.interface';

function user(
  roles: AuthenticatedUser['roles'],
  id = 'u1',
): AuthenticatedUser {
  return { id, phone: '+201000000001', name: 'User', roles };
}

function db(venue: Record<string, unknown> | null, assignment = false) {
  return {
    venue: { findUnique: jest.fn().mockResolvedValue(venue) },
    booking: {
      findUnique: jest.fn().mockResolvedValue(
        venue ? { id: 'b1', venueId: 'v1' } : null,
      ),
    },
    // Staff reach a venue only through their StaffMember row (same owner, venue in the list).
    staffMember: {
      findUnique: jest.fn().mockResolvedValue(
        assignment
          ? { id: 's1', ownerId: 'owner-1', permissions: [], venueIds: ['v1'], title: null }
          : null,
      ),
    },
  };
}

const venue = { id: 'v1', ownerId: 'owner-1' };

describe('assertVenueAccess matrix', () => {
  const cases: Array<{
    name: string;
    roles: AuthenticatedUser['roles'];
    id: string;
    write: boolean;
    assignment?: boolean;
    ok?: boolean;
    error?: new (...args: never[]) => Error;
    code?: string;
  }> = [
    { name: 'owner read', roles: ['owner'], id: 'owner-1', write: false, ok: true },
    { name: 'owner write', roles: ['owner'], id: 'owner-1', write: true, ok: true },
    { name: 'staff read', roles: ['staff'], id: 'staff-1', write: false, assignment: true, ok: true },
    { name: 'staff write', roles: ['staff'], id: 'staff-1', write: true, assignment: true, ok: true },
    { name: 'admin read', roles: ['admin'], id: 'admin-1', write: false, ok: true },
    { name: 'admin write', roles: ['admin'], id: 'admin-1', write: true, code: 'ADMIN_READ_ONLY' },
    { name: 'other owner', roles: ['owner'], id: 'other', write: false, error: ForbiddenException },
    { name: 'player', roles: ['player'], id: 'player-1', write: false, error: ForbiddenException },
    { name: 'staff without a StaffMember row', roles: ['staff'], id: 'staff-1', write: false, error: ForbiddenException },
  ];

  it.each(cases)('$name', async (c) => {
    const prisma = db(venue, c.assignment) as never;
    const actor = user(c.roles, c.id);
    if (c.ok) {
      await expect(assertVenueAccess(prisma, actor, 'v1', { write: c.write })).resolves.toMatchObject(venue);
      return;
    }
    try {
      await assertVenueAccess(prisma, actor, 'v1', { write: c.write });
      throw new Error('expected throw');
    } catch (err) {
      if (c.code) {
        expect(err).toBeInstanceOf(ApiException);
        expect((err as ApiException).getResponse()).toEqual(
          expect.objectContaining({ code: c.code }),
        );
      } else {
        expect(err).toBeInstanceOf(c.error ?? ForbiddenException);
      }
    }
  });

  it('404s when the venue does not exist', async () => {
    await expect(
      assertVenueAccess(db(null) as never, user(['owner'], 'owner-1'), 'missing', { write: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('assertBookingAccess', () => {
  it('loads the booking then applies venue rules', async () => {
    const prisma = db(venue) as never;
    const result = await assertBookingAccess(prisma, user(['owner'], 'owner-1'), 'b1', { write: false });
    expect(result.booking).toMatchObject({ id: 'b1', venueId: 'v1' });
    expect(result.venue).toMatchObject(venue);
  });

  it('404s when the booking is missing', async () => {
    const prisma = db(venue) as never;
    (prisma as { booking: { findUnique: jest.Mock } }).booking.findUnique.mockResolvedValue(null);
    await expect(
      assertBookingAccess(prisma, user(['owner'], 'owner-1'), 'missing', { write: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
