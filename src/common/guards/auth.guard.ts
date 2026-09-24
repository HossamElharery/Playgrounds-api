import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import {
  ANY_PERMISSION_KEY,
  ANY_STAFF_KEY,
  OWNER_ONLY_KEY,
  PERMISSIONS_KEY,
} from '../decorators/permissions.decorator';
import { loadStaffScope } from '../access/staff-scope';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../modules/prisma/prisma.service';

/** API paths a guest identity may call (after the global prefix). */
const GUEST_ALLOWED = /^\/api\/v1\/(squad|auth|users\/me|realtime|presence|morphs)(\/|\?|$)/;
/** Read-only extras the player shell polls on boot; empty for a fresh guest. */
const GUEST_READ_ONLY = /^\/api\/v1\/(friends|friend-requests|notifications)(\/|\?|$)/;

/**
 * Single generic guard for the whole API:
 * - @Public() routes always pass.
 * - Otherwise a valid `request.user` (set by AuthContextMiddleware) is required.
 * - @Roles(...) restricts by top-level role (player/owner/staff/admin).
 * - @RequirePermission(...) checks the permission keys held by a `staff` user's
 *   StaffMember row. Owners and admins hold every key.
 * - Routes open to `staff` are FAIL-CLOSED: they must declare @RequirePermission,
 *   @OwnerOnly or @AnyStaff, otherwise a staff account is refused. A new route
 *   therefore cannot leak to staff by omission.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    let user = request.user;
    if (!user?.id) {
      throw new UnauthorizedException('Authentication required');
    }

    // Roles and suspension changes must take effect even for an unexpired JWT.
    const current = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, roles: true, status: true, isGuest: true },
    });
    if (!current || current.status !== 'active')
      throw new UnauthorizedException('Account is not active');
    user = request.user = { ...user, roles: current.roles };
    // Guests (squad-link visitors) are confined to the squad/auth surface so a
    // throw-away identity can never reach bookings, wallet, chat, etc.
    const url: string = request.originalUrl ?? request.url ?? '';
    if (
      current.isGuest &&
      !GUEST_ALLOWED.test(url) &&
      !(request.method === 'GET' && GUEST_READ_ONLY.test(url))
    ) {
      throw new ForbiddenException('Create an account to use this feature');
    }
    // "Edit as this venue" is an explicit, per-request opt-in the admin UI sends only
    // while its edit mode is switched on; it means nothing for anyone who is not admin.
    if (current.roles.includes('admin') && request.headers?.['x-admin-edit'] === '1') {
      user.adminEdit = true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredRoles?.length) {
      const hasRole = (user.roles ?? []).some((r: UserRole) =>
        requiredRoles.includes(r),
      );
      if (!hasRole) {
        throw new ForbiddenException('Insufficient role');
      }
    }

    const handlerTargets = [context.getHandler(), context.getClass()];
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      handlerTargets,
    );
    const anyPermissions = this.reflector.getAllAndOverride<string[]>(
      ANY_PERMISSION_KEY,
      handlerTargets,
    );
    const ownerOnly = this.reflector.getAllAndOverride<boolean>(OWNER_ONLY_KEY, handlerTargets);
    const anyStaff = this.reflector.getAllAndOverride<boolean>(ANY_STAFF_KEY, handlerTargets);

    const roles: UserRole[] = user.roles ?? [];
    const isPrivileged = roles.some((r) => r === 'admin' || r === 'owner');
    const isStaff = !isPrivileged && roles.includes('staff');

    if (isStaff) {
      const staffRoute = requiredRoles?.includes('staff') ?? false;
      if (ownerOnly) throw new ForbiddenException('This action is limited to the venue owner');
      if (staffRoute || requiredPermissions?.length || anyPermissions?.length) {
        if (!requiredPermissions?.length && !anyPermissions?.length && !anyStaff) {
          throw new ForbiddenException('Staff access to this action is not enabled');
        }
        const scope = await loadStaffScope(this.prisma, user.id);
        if (!scope) throw new ForbiddenException('This staff account has no access');
        const granted = new Set(scope.permissions);
        if (!(requiredPermissions ?? []).every((p) => granted.has(p))) {
          throw new ForbiddenException('Insufficient permissions');
        }
        if (anyPermissions?.length && !anyPermissions.some((p) => granted.has(p))) {
          throw new ForbiddenException('Insufficient permissions');
        }
        request.staffScope = scope;
      }
    }

    return true;
  }
}
