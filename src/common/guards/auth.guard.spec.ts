import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { PrismaService } from '../../modules/prisma/prisma.service';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  let reflector: Reflector;
  let prisma: any;
  let guard: AuthGuard;

  beforeEach(() => {
    reflector = new Reflector();
    prisma = {
      userRoleAssignment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    guard = new AuthGuard(reflector, prisma as PrismaService);
  });

  it('allows a public route with no authenticated user', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValueOnce(true); // IS_PUBLIC_KEY
    await expect(guard.canActivate(contextWithUser(undefined))).resolves.toBe(
      true,
    );
  });

  it('rejects a protected route with no authenticated user', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    await expect(
      guard.canActivate(contextWithUser(undefined)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a user missing the required role', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValueOnce(false) // IS_PUBLIC_KEY
      .mockReturnValueOnce(['admin']); // ROLES_KEY
    const ctx = contextWithUser({ id: 'u1', roles: ['player'] });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows a user holding one of the required roles', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(['admin', 'owner']);
    const ctx = contextWithUser({ id: 'u1', roles: ['owner'] });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('lets admin bypass fine-grained permission checks', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValueOnce(false) // IS_PUBLIC_KEY
      .mockReturnValueOnce(undefined) // ROLES_KEY
      .mockReturnValueOnce(['calendar.manage']); // PERMISSIONS_KEY
    const ctx = contextWithUser({ id: 'u1', roles: ['admin'] });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.userRoleAssignment.findMany).not.toHaveBeenCalled();
  });

  it('rejects staff lacking the specific granted permission', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(['calendar.manage']);
    prisma.userRoleAssignment.findMany.mockResolvedValue([
      { role: { permissions: [{ permission: { key: 'bookings.checkin' } }] } },
    ]);
    const ctx = contextWithUser({ id: 'u1', roles: ['staff'] });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows staff holding the specific granted permission', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(['calendar.manage']);
    prisma.userRoleAssignment.findMany.mockResolvedValue([
      { role: { permissions: [{ permission: { key: 'calendar.manage' } }] } },
    ]);
    const ctx = contextWithUser({ id: 'u1', roles: ['staff'] });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
