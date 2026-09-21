import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../decorators/roles.decorator';
import {
  ANY_PERMISSION_KEY,
  ANY_STAFF_KEY,
  OWNER_ONLY_KEY,
  PERMISSIONS_KEY,
} from '../decorators/permissions.decorator';
import { PERMISSION_CATALOG, PERMISSION_KEYS, PERMISSION_PRESETS, normalizePermissions } from './permissions';
import { OwnerController } from '../../modules/owner/owner.controller';
import { VenuesController } from '../../modules/venues/venues.controller';
import { BookingsController } from '../../modules/bookings/bookings.controller';
import { RewardsController } from '../../modules/rewards/rewards.controller';
import { TournamentsController } from '../../modules/tournaments/tournaments.controller';
import { TeamController } from '../../modules/team/team.controller';
import { SubscriptionsController } from '../../modules/subscriptions/subscriptions.controller';
import { ReviewsController } from '../../modules/reviews/reviews.controller';

const CONTROLLERS = [
  OwnerController,
  VenuesController,
  BookingsController,
  RewardsController,
  TournamentsController,
  TeamController,
  SubscriptionsController,
  ReviewsController,
];

function routes(controller: Function) {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((k) => k !== 'constructor' && typeof proto[k] === 'function')
    .map((k) => {
      const fn = proto[k] as object;
      return { name: `${controller.name}.${k}`, fn, isRoute: Reflect.getMetadata(METHOD_METADATA, fn) !== undefined, path: Reflect.getMetadata(PATH_METADATA, fn) };
    })
    .filter((r) => r.isRoute);
}

const meta = (key: string, fn: object, controller: object) =>
  Reflect.getMetadata(key, fn) ?? Reflect.getMetadata(key, controller);

describe('staff permission coverage', () => {
  it('every route a staff account can reach declares its permission (fail-closed by construction)', () => {
    const undeclared: string[] = [];
    let staffRoutes = 0;
    for (const controller of CONTROLLERS) {
      for (const route of routes(controller)) {
        const roles: string[] | undefined = meta(ROLES_KEY, route.fn, controller);
        if (!roles?.includes('staff')) continue;
        staffRoutes += 1;
        const declared =
          meta(PERMISSIONS_KEY, route.fn, controller)?.length ||
          meta(ANY_PERMISSION_KEY, route.fn, controller)?.length ||
          meta(ANY_STAFF_KEY, route.fn, controller) ||
          meta(OWNER_ONLY_KEY, route.fn, controller);
        if (!declared) undeclared.push(route.name);
      }
    }
    expect(staffRoutes).toBeGreaterThan(30);
    expect(undeclared).toEqual([]);
  });

  it('only ever names permission keys that exist', () => {
    const known = new Set<string>(PERMISSION_KEYS);
    const unknown: string[] = [];
    for (const controller of CONTROLLERS) {
      for (const route of routes(controller)) {
        for (const key of [
          ...(meta(PERMISSIONS_KEY, route.fn, controller) ?? []),
          ...(meta(ANY_PERMISSION_KEY, route.fn, controller) ?? []),
        ]) {
          if (!known.has(key)) unknown.push(`${route.name} → ${key}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('the money routes are not open to a reception-only account', () => {
    const reception = new Set(PERMISSION_PRESETS.find((p) => p.key === 'reception')!.permissions);
    const guarded = new Map(routes(OwnerController).map((r) => [r.path as string, meta(PERMISSIONS_KEY, r.fn, OwnerController) as string[] | undefined]));
    for (const path of ['summary', 'finance', 'finance/export', 'matchena-account', 'matchena-account/remittances']) {
      const needs = guarded.get(path) ?? [];
      expect(needs.length).toBeGreaterThan(0);
      expect(needs.every((k) => reception.has(k as never))).toBe(false);
    }
  });

  it('payout methods and the old overview are owner-only', () => {
    const only = routes(OwnerController)
      .filter((r) => meta(OWNER_ONLY_KEY, r.fn, OwnerController))
      .map((r) => r.path);
    expect(only).toEqual(expect.arrayContaining(['payout-methods', 'payout-methods/:id', 'overview']));
  });

  it('presets and dependencies are coherent', () => {
    for (const preset of PERMISSION_PRESETS) {
      expect(normalizePermissions(preset.permissions).sort()).toEqual([...preset.permissions].sort());
    }
    expect(PERMISSION_CATALOG.map((p) => p.key).sort()).toEqual([...PERMISSION_KEYS].sort());
    // Asking for "edit bookings" alone pulls in "see bookings".
    expect(normalizePermissions(['bookings.edit'])).toEqual(['bookings.view', 'bookings.edit']);
    expect(normalizePermissions(['nonsense', 'reports.view'])).toEqual(['reports.view']);
  });

  it('fixed bookings: reception (create only) cannot skip/cancel/reschedule', () => {
    const perm = (path: string, method: number) =>
      routes(OwnerController).find((r) => r.path === path && Reflect.getMetadata(METHOD_METADATA, r.fn) === method);
    const need = (r?: { fn: object }) => Reflect.getMetadata(PERMISSIONS_KEY, r!.fn);
    expect(need(perm('fixed-bookings', 1))).toEqual(['bookings.create']);
    expect(need(perm('fixed-bookings/preview', 1))).toEqual(['bookings.view']);
    expect(need(perm('fixed-bookings', 0))).toEqual(['bookings.view']);
    for (const action of ['skip', 'cancel-from', 'reschedule']) {
      expect(need(perm(`fixed-bookings/:id/${action}`, 1))).toEqual(['bookings.edit']);
    }
  });
});
