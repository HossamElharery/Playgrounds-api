import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { VenuesController } from './venues.controller';
import { ManagementController } from '../admin/management.controller';

function route(controller: Function, name: string) {
  const fn = (controller.prototype as Record<string, object>)[name];
  return {
    path: Reflect.getMetadata(PATH_METADATA, fn) as string,
    method: Reflect.getMetadata(METHOD_METADATA, fn) as number,
    roles: (Reflect.getMetadata(ROLES_KEY, fn) ?? Reflect.getMetadata(ROLES_KEY, controller)) as string[] | undefined,
  };
}

describe('who may reach the visibility endpoints', () => {
  it.each([
    ['visibility', 'owner/venues/:id/visibility'],
    ['setListing', 'owner/venues/:id/listing'],
    ['setBookingAvailability', 'owner/venues/:id/booking-availability'],
    ['setOperations', 'owner/venues/:id/operations'],
  ])('owner route %s is for owners (and admins in edit mode), never staff', (name, path) => {
    const r = route(VenuesController, name);
    expect(r.path).toBe(path);
    expect(r.roles).toEqual(['owner', 'admin']);
    expect(r.roles).not.toContain('staff');
  });

  it.each([
    ['setListing', 'venues/:id/listing'],
    ['setStatus', 'venues/:id/status'],
    ['visibility', 'venues/:id/visibility'],
  ])('admin route %s is admin only', (name, path) => {
    const r = route(ManagementController, name);
    expect(r.path).toBe(path);
    expect(r.roles).toEqual(['admin']);
  });

  it('keeps the legacy admin suspend route admin only', () => {
    expect(route(VenuesController, 'suspend').roles).toEqual(['admin']);
  });
});
