import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { loadStaffScope } from './staff-scope';
import { PrismaService } from '../../modules/prisma/prisma.service';
import type { AuthenticatedUser } from '../types/authenticated-user.interface';

export async function assertVenueStaffAccess(
  prisma: PrismaService,
  venueId: string,
  user: AuthenticatedUser,
) {
  if (user.roles.includes('admin')) {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, ownerId: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    return venue;
  }

  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true, ownerId: true },
  });
  if (!venue) throw new NotFoundException('Venue not found');
  if (user.roles.includes('owner') && venue.ownerId === user.id) return venue;

  if (user.roles.includes('staff')) {
    const scope = await loadStaffScope(prisma, user.id);
    if (scope && scope.ownerId === venue.ownerId && scope.venueIds.includes(venueId)) {
      return venue;
    }
  }

  throw new ForbiddenException('Not your venue');
}
