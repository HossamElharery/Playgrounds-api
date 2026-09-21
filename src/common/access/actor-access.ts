import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import type { AuthenticatedUser } from '../types/authenticated-user.interface';
import { loadStaffScope, type StaffScope } from './staff-scope';

/**
 * For services that authorise with `(id, ownerId, isPrivileged)`.
 *
 * The guard has already checked the staff member's PERMISSION KEY; this checks the
 * other half — that the venue is one of theirs. A staff member then acts AS their
 * owner (`actingOwnerId`) with `privileged = false`, so the service's own ownership
 * check still runs and admin-only fields (SEO overrides…) stay admin-only.
 *   admin → privileged (skips the ownership check)
 *   owner → not privileged, acts as themselves
 *   staff → not privileged, acts as the owner they work for
 */
export async function venueActorPrivilege(
  prisma: PrismaService,
  user: AuthenticatedUser,
  venueId: string,
): Promise<boolean> {
  if (user.roles.includes('admin')) return true;
  if (user.roles.includes('owner')) return false;
  await requireStaffVenue(prisma, user, venueId);
  return false;
}

/** The owner id to hand to ownership-checking services: the staff member's employer, else the caller. */
export async function actingOwnerId(prisma: PrismaService, user: AuthenticatedUser): Promise<string> {
  if (user.roles.includes('admin') || user.roles.includes('owner')) return user.id;
  const scope = await loadStaffScope(prisma, user.id);
  return scope?.ownerId ?? user.id;
}

export async function requireStaffVenue(
  prisma: PrismaService,
  user: AuthenticatedUser,
  venueId: string,
): Promise<StaffScope> {
  const scope = await loadStaffScope(prisma, user.id);
  if (!scope) throw new ForbiddenException('This staff account has no access');
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { ownerId: true } });
  if (!venue) throw new NotFoundException('Venue not found');
  if (venue.ownerId !== scope.ownerId || !scope.venueIds.includes(venueId)) {
    throw new ForbiddenException('Not your venue');
  }
  return scope;
}

export async function venueIdOfCourt(prisma: PrismaService, courtId: string): Promise<string> {
  const court = await prisma.court.findUnique({ where: { id: courtId }, select: { venueId: true } });
  if (!court) throw new NotFoundException('Court not found');
  return court.venueId;
}

export async function venueIdOfPricingRule(prisma: PrismaService, ruleId: string): Promise<string> {
  const rule = await prisma.pricingRule.findUnique({
    where: { id: ruleId },
    select: { court: { select: { venueId: true } } },
  });
  if (!rule) throw new NotFoundException('Pricing rule not found');
  return rule.court.venueId;
}
