import { PrismaService } from '../../modules/prisma/prisma.service';
import type { PermissionKey } from './permissions';

export interface StaffScope {
  staffId: string;
  ownerId: string;
  permissions: string[];
  venueIds: string[];
  title: string | null;
}

/** The staff member behind a user, or null when the account is not (or no longer) staff. */
export async function loadStaffScope(
  prisma: Pick<PrismaService, 'staffMember'>,
  userId: string,
): Promise<StaffScope | null> {
  const row = await prisma.staffMember.findUnique({ where: { userId } });
  if (!row) return null;
  return {
    staffId: row.id,
    ownerId: row.ownerId,
    permissions: row.permissions,
    venueIds: row.venueIds,
    title: row.title,
  };
}

export function scopeCan(scope: StaffScope | null, permission: PermissionKey): boolean {
  return !!scope && scope.permissions.includes(permission);
}
