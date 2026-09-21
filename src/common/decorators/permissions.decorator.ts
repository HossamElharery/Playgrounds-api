import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const OWNER_ONLY_KEY = 'ownerOnly';
/** Owner (or admin) only: a staff account is refused even if it holds every permission key. */
export const OwnerOnly = () => SetMetadata(OWNER_ONLY_KEY, true);

export const ANY_STAFF_KEY = 'anyStaff';
/** Any signed-in staff account of the venue may call this (read-only helpers such as "my access"). */
export const AnyStaff = () => SetMetadata(ANY_STAFF_KEY, true);

export const ANY_PERMISSION_KEY = 'anyPermission';
/** Staff need at least ONE of these keys (e.g. "edit venue" OR "change prices"). */
export const RequireAnyPermission = (...permissions: string[]) =>
  SetMetadata(ANY_PERMISSION_KEY, permissions);
