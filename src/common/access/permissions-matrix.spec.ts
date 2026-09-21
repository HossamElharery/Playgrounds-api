import { METHOD_METADATA } from '@nestjs/common/constants';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '../guards/auth.guard';
import { PERMISSION_KEYS } from './permissions';
import { OwnerController } from '../../modules/owner/owner.controller';
import { TeamController } from '../../modules/team/team.controller';
import { SubscriptionsController } from '../../modules/subscriptions/subscriptions.controller';

/**
 * Generated from the real controllers' metadata and run through the real AuthGuard:
 * for every staff-reachable route, a staff account holding every permission EXCEPT the
 * ones the route needs is refused, one holding exactly those is admitted, and a route
 * marked owner-only refuses staff no matter what they hold. New routes are covered
 * automatically — nobody has to remember to add a case.
 */
const CONTROLLERS = [OwnerController, TeamController, SubscriptionsController];

function handlers(controller: Function) {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((k) => k !== 'constructor' && typeof proto[k] === 'function' && Reflect.getMetadata(METHOD_METADATA, proto[k] as object) !== undefined)
    .map((k) => ({ name: `${controller.name}.${k}`, fn: proto[k] as object, controller }));
}

function ctx(h: { fn: object; controller: Function }): ExecutionContext {
  const request = { user: { id: 'u1', roles: ['staff'] } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => h.fn,
    getClass: () => h.controller,
  } as unknown as ExecutionContext;
}

function guardFor(permissions: string[]) {
  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', status: 'active', roles: ['staff'] }) },
    staffMember: {
      findUnique: jest.fn().mockResolvedValue({ id: 's', userId: 'u1', ownerId: 'o', permissions, venueIds: ['v1'], title: null }),
    },
  };
  return new AuthGuard(new Reflector(), prisma);
}

const meta = (key: string, h: { fn: object; controller: Function }) =>
  Reflect.getMetadata(key, h.fn) ?? Reflect.getMetadata(key, h.controller);

describe('permission matrix (generated)', () => {
  const all = CONTROLLERS.flatMap(handlers);

  it('covers a meaningful number of routes', () => {
    expect(all.length).toBeGreaterThan(45);
  });

  for (const h of all) {
    const required: string[] = meta('permissions', h) ?? [];
    const ownerOnly = !!meta('ownerOnly', h);
    const roles: string[] = meta('roles', h) ?? [];
    if (!roles.includes('staff')) continue;

    if (ownerOnly) {
      it(`${h.name}: owner-only, refuses even a fully-permissioned staff account`, async () => {
        await expect(guardFor([...PERMISSION_KEYS]).canActivate(ctx(h))).rejects.toMatchObject({ status: 403 });
      });
    } else if (required.length) {
      it(`${h.name}: needs ${required.join('+')}`, async () => {
        const without = PERMISSION_KEYS.filter((k) => !required.includes(k));
        await expect(guardFor(without).canActivate(ctx(h))).rejects.toMatchObject({ status: 403 });
        await expect(guardFor(required).canActivate(ctx(h))).resolves.toBe(true);
      });
    }
  }
});
