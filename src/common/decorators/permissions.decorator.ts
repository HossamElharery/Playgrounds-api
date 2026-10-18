import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const OWNER_ONLY_KEY = 'ownerOnly';
export const OwnerOnly = () => SetMetadata(OWNER_ONLY_KEY, true);

export const ANY_STAFF_KEY = 'anyStaff';
export const AnyStaff = () => SetMetadata(ANY_STAFF_KEY, true);

export const ANY_PERMISSION_KEY = 'anyPermission';
export const RequireAnyPermission = (...permissions: string[]) =>
  SetMetadata(ANY_PERMISSION_KEY, permissions);
