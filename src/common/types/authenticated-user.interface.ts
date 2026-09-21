import { UserRole } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  phone: string;
  email?: string | null;
  name: string;
  roles: UserRole[];
  countryCode?: string;
  /** Admin only: the request carries X-Admin-Edit, i.e. "edit as this venue" mode is on. */
  adminEdit?: boolean;
}
