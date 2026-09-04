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
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../modules/prisma/prisma.service';

/**
 * Single generic guard for the whole API:
 * - @Public() routes always pass.
 * - Otherwise a valid `request.user` (set by AuthContextMiddleware) is required.
 * - @Roles(...) restricts by top-level role (player/owner/staff/admin).
 * - @RequirePermission(...) additionally checks the fine-grained owner-staff
 *   permission table for `staff` users (see the `rbac` module).
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
    const user = request.user;
    if (!user?.id) {
      throw new UnauthorizedException('Authentication required');
    }

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRoles?.length) {
      const hasRole = (user.roles ?? []).some((r: UserRole) => requiredRoles.includes(r));
      if (!hasRole) {
        throw new ForbiddenException('Insufficient role');
      }
    }

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredPermissions?.length) {
      // admin/owner bypass fine-grained permission checks; staff must hold them explicitly
      const isPrivileged = (user.roles ?? []).some((r: UserRole) =>
        ['admin', 'owner'].includes(r),
      );
      if (!isPrivileged) {
        const assignments = await this.prisma.userRoleAssignment.findMany({
          where: { userId: user.id },
          include: { role: { include: { permissions: { include: { permission: true } } } } },
        });
        const grantedKeys = new Set(
          assignments.flatMap((a) => a.role.permissions.map((p) => p.permission.key)),
        );
        const hasAll = requiredPermissions.every((p) => grantedKeys.has(p));
        if (!hasAll) {
          throw new ForbiddenException('Insufficient permissions');
        }
      }
    }

    return true;
  }
}
