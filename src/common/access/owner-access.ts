import { ForbiddenException, HttpStatus, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import type { AuthenticatedUser } from '../types/authenticated-user.interface';
import { ApiException } from '../errors/api-exception';
import { Venue } from '@prisma/client';
import { loadStaffScope, scopeCan } from './staff-scope';
import type { PermissionKey } from './permissions';

export async function assertVenueAccess(
  prisma: PrismaService,
  user: AuthenticatedUser,
  venueId: string,
  opts: { write: boolean },
): Promise<Venue> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId } });
  if (!venue) throw new NotFoundException('Venue not found');

  if (user.roles.includes('admin')) {
    // The admin can do everything, but only on purpose: writes need edit mode.
    if (opts.write && !user.adminEdit) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'ADMIN_READ_ONLY',
        'Admins can view owner data. Switch on edit mode to change it.',
      );
    }
    return venue;
  }

  if (user.roles.includes('owner') && venue.ownerId === user.id) {
    return venue;
  }

  if (user.roles.includes('staff')) {
    // Staff reach a venue only through their StaffMember row: same owner, venue in their list.
    const scope = await loadStaffScope(prisma, user.id);
    if (scope && scope.ownerId === venue.ownerId && scope.venueIds.includes(venueId)) {
      return venue;
    }
  }

  throw new ForbiddenException('Not your venue');
}

export async function assertBookingAccess(
  prisma: PrismaService,
  user: AuthenticatedUser,
  bookingId: string,
  opts: { write: boolean },
) {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) throw new NotFoundException('Booking not found');
  const venue = await assertVenueAccess(prisma, user, booking.venueId, opts);
  return { booking, venue };
}

/** Secondary permissions must also hold when an operation writes through another service. */
export async function assertStaffPermission(prisma: PrismaService, user: AuthenticatedUser, permission: PermissionKey) {
  return assertStaffAnyPermission(prisma, user, [permission]);
}

export async function assertStaffAnyPermission(prisma: PrismaService, user: AuthenticatedUser, permissions: PermissionKey[]) {
  if (user.roles.includes('owner') || user.roles.includes('admin')) return;
  const scope = user.roles.includes('staff') ? await loadStaffScope(prisma, user.id) : null;
  if (!permissions.some(permission => scopeCan(scope, permission))) {
    throw new ApiException(HttpStatus.FORBIDDEN, 'INSUFFICIENT_PERMISSION', 'You do not have permission for this action');
  }
}
