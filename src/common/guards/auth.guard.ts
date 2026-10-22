import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiException } from '../errors/api-exception';
import { HttpStatus } from '@nestjs/common';
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

const GUEST_ALLOWED = /^\/api\/v1\/(squad|realtime|presence|morphs|lobby|camo)(\/|\?|$)/;
const GUEST_SQUAD_WRITE = /^\/api\/v1\/squad\/(start|invite-link(?:\/reset)?|invites|join-requests\/[^/]+\/(approve|decline)|[^/]+\/(kick|make-leader|mute)\/[^/]+)(\?|$)/;
const GUEST_AUTH = /^\/api\/v1\/auth\/(guest\/(email\/otp|complete|oauth\/(google|facebook|apple))|logout-all)(\?|$)/;
const GUEST_SELF = /^\/api\/v1\/users\/me(\?|$)/;
const GUEST_READ_ONLY = /^\/api\/v1\/(friends|friend-requests|notifications)(\/|\?|$)/;

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
    const url: string = request.originalUrl ?? request.url ?? '';
    if (
      current.isGuest &&
      (request.method !== 'GET' && GUEST_SQUAD_WRITE.test(url) ||
      !GUEST_ALLOWED.test(url) &&
      !(request.method === 'POST' && GUEST_AUTH.test(url)) &&
      !(['GET', 'DELETE'].includes(request.method) && GUEST_SELF.test(url)) &&
      !(request.method === 'GET' && GUEST_READ_ONLY.test(url)))
    ) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'GUEST_ACCOUNT_REQUIRED', 'Create an account to use this feature');
    }
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
