import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import {
  ANY_PERMISSION_KEY,
  ANY_STAFF_KEY,
  OWNER_ONLY_KEY,
  PERMISSIONS_KEY,
} from '../decorators/permissions.decorator';

function contextWithUser(user: unknown): ExecutionContext {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

/** Route metadata by key, so tests read like the decorators they stand for. */
function route(meta: Partial<Record<string, unknown>>) {
  return (key: string) => meta[key];
}

describe('AuthGuard', () => {
  let reflector: Reflector;
  let prisma: any;
  let guard: AuthGuard;

  const asUser = (roles: string[]) =>
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', status: 'active', roles });
  const withMeta = (meta: Partial<Record<string, unknown>>) =>
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation(route(meta) as never);
  const withStaff = (permissions: string[], venueIds = ['v1']) =>
    prisma.staffMember.findUnique.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      ownerId: 'owner-1',
      permissions,
      venueIds,
      title: null,
    });

  beforeEach(() => {
    reflector = new Reflector();
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'u1', status: 'active', roles: ['player'] }),
      },
      staffMember: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    guard = new AuthGuard(reflector, prisma as PrismaService);
  });

  it('allows a public route with no authenticated user', async () => {
    withMeta({ [IS_PUBLIC_KEY]: true });
    await expect(guard.canActivate(contextWithUser(undefined))).resolves.toBe(true);
  });

  it('rejects a protected route with no authenticated user', async () => {
    withMeta({});
    await expect(guard.canActivate(contextWithUser(undefined))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a user missing the required role', async () => {
    withMeta({ [ROLES_KEY]: ['admin'] });
    await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: ['player'] }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows a user holding one of the required roles', async () => {
    asUser(['owner']);
    withMeta({ [ROLES_KEY]: ['admin', 'owner'] });
    await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: ['owner'] }))).resolves.toBe(true);
  });

  it('lets admin and owner bypass permission checks', async () => {
    for (const role of ['admin', 'owner']) {
      asUser([role]);
      withMeta({ [ROLES_KEY]: ['owner', 'staff', 'admin'], [PERMISSIONS_KEY]: ['bookings.edit'] });
      await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: [role] }))).resolves.toBe(true);
    }
    expect(prisma.staffMember.findUnique).not.toHaveBeenCalled();
  });

  describe('staff', () => {
    const staffRoute = { [ROLES_KEY]: ['owner', 'staff', 'admin'] };

    beforeEach(() => asUser(['staff']));

    it('is refused a permission it does not hold', async () => {
      withStaff(['bookings.view']);
      withMeta({ ...staffRoute, [PERMISSIONS_KEY]: ['bookings.edit'] });
      await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: ['staff'] }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('is allowed a permission it holds, and the scope is attached to the request', async () => {
      withStaff(['bookings.view', 'bookings.edit']);
      withMeta({ ...staffRoute, [PERMISSIONS_KEY]: ['bookings.edit'] });
      const ctx = contextWithUser({ id: 'u1', roles: ['staff'] });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect((ctx.switchToHttp().getRequest() as { staffScope: { ownerId: string } }).staffScope.ownerId).toBe('owner-1');
    });

    it('needs ALL of several required permissions', async () => {
      withStaff(['bookings.view']);
      withMeta({ ...staffRoute, [PERMISSIONS_KEY]: ['bookings.view', 'reports.view'] });
      await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: ['staff'] }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('needs only ONE of an any-of list', async () => {
      withStaff(['pricing.manage']);
      withMeta({ ...staffRoute, [ANY_PERMISSION_KEY]: ['venue.manage', 'pricing.manage'] });
      await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: ['staff'] }))).resolves.toBe(true);
      withStaff(['reports.view']);
      await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: ['staff'] }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('fails closed: a staff route that declares nothing is refused', async () => {
      withStaff(['bookings.view']);
      withMeta(staffRoute);
      await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: ['staff'] }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('is refused an owner-only route even holding every key', async () => {
      withStaff(['bookings.view', 'team.manage']);
      withMeta({ ...staffRoute, [OWNER_ONLY_KEY]: true });
      await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: ['staff'] }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('may call an any-staff route with no specific key', async () => {
      withStaff([]);
      withMeta({ ...staffRoute, [ANY_STAFF_KEY]: true });
      await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: ['staff'] }))).resolves.toBe(true);
    });

    it('a user with the staff role but no StaffMember row has no access', async () => {
      prisma.staffMember.findUnique.mockResolvedValue(null);
      withMeta({ ...staffRoute, [PERMISSIONS_KEY]: ['bookings.view'] });
      await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: ['staff'] }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  it('rejects a suspended account even with an unexpired administrator token', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', status: 'suspended', roles: ['admin'] });
    await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: ['admin'] }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('uses current database roles instead of stale administrator token claims', async () => {
    withMeta({ [ROLES_KEY]: ['admin'] });
    await expect(guard.canActivate(contextWithUser({ id: 'u1', roles: ['admin'] }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('AuthGuard admin edit mode', () => {
  const build = (roles: string[]) => {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', status: 'active', roles }) },
      staffMember: { findUnique: jest.fn() },
    };
    const request: any = { user: { id: 'u1', roles }, headers: { 'x-admin-edit': '1' } };
    const ctx = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
    return { guard: new AuthGuard(new Reflector(), prisma), request, ctx };
  };

  it('flags an admin request that carries X-Admin-Edit', async () => {
    const { guard, request, ctx } = build(['admin']);
    await guard.canActivate(ctx);
    expect(request.user.adminEdit).toBe(true);
  });

  it('ignores the header for everyone who is not an admin', async () => {
    for (const role of ['owner', 'staff', 'player']) {
      const { guard, request, ctx } = build([role]);
      await guard.canActivate(ctx);
      expect(request.user.adminEdit).toBeUndefined();
    }
  });
});

describe('AuthGuard guest confinement', () => {
  const guestRequest = (url: string, method = 'GET') => {
    const prisma: any = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'g1', status: 'active', roles: ['player'], isGuest: true }),
      },
      staffMember: { findUnique: jest.fn() },
    };
    const request: any = { user: { id: 'g1', roles: ['player'] }, headers: {}, originalUrl: url, method };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    return { guard: new AuthGuard(new Reflector(), prisma), ctx };
  };

  it('lets a guest in a lobby read the Lobby World feature flags', async () => {
    const { guard, ctx } = guestRequest('/api/v1/lobby/features');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('still keeps guests out of everything else (e.g. bookings, lobbyist look-alikes)', async () => {
    for (const url of ['/api/v1/bookings/mine', '/api/v1/lobbyist', '/api/v1/lobbyfeatures']) {
      const { guard, ctx } = guestRequest(url);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
});
