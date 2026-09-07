import { UserRole } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  phone: string;
  email?: string | null;
  name: string;
  roles: UserRole[];
  countryCode?: string;
}
