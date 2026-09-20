import { ForbiddenException, HttpStatus, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import type { AuthenticatedUser } from '../types/authenticated-user.interface';
import { ApiException } from '../errors/api-exception';
import { Venue } from '@prisma/client';

export async function assertVenueAccess(
  prisma: PrismaService,
  user: AuthenticatedUser,
  venueId: string,
  opts: { write: boolean },
): Promise<Venue> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId } });
  if (!venue) throw new NotFoundException('Venue not found');

  if (user.roles.includes('admin')) {
    if (opts.write) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'ADMIN_READ_ONLY',
        'Admins can view owner data but cannot change it here',
      );
    }
    return venue;
  }

  if (user.roles.includes('owner') && venue.ownerId === user.id) {
    return venue;
  }

  if (user.roles.includes('staff')) {
    const assignment = await prisma.userRoleAssignment.findFirst({
      where: { userId: user.id, venueId },
      select: { id: true },
    });
    if (assignment) return venue;
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
