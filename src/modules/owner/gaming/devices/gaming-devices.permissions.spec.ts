import 'reflect-metadata';
import { GamingDevicesController } from './gaming-devices.controller';
import { GamingHubsController } from './gaming-hubs.controller';
import { PERMISSIONS_KEY } from '../../../../common/decorators/permissions.decorator';

/**
 * Every owner route that touches consoles, TVs, plugs or the Hub needs the "control consoles and screens"
 * permission. A staff member without it must not link, replace, test or remove anything.
 */
function routes(controller: { prototype: object }) {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
    .map((name) => ({
      name,
      path: Reflect.getMetadata('path', proto[name] as object) as string | undefined,
      permissions: Reflect.getMetadata(PERMISSIONS_KEY, proto[name] as object) as string[] | undefined,
    }))
    .filter((r) => r.path !== undefined);
}

describe('device and Hub owner routes are permission-gated', () => {
  it.each([
    ['devices', GamingDevicesController],
    ['hubs', GamingHubsController],
  ])('every %s route requires devices.manage', (_name, controller) => {
    const list = routes(controller);
    expect(list.length).toBeGreaterThan(5);
    for (const r of list) expect({ route: r.name, permissions: r.permissions }).toEqual({ route: r.name, permissions: ['devices.manage'] });
  });

  it('the smart-TV routes exist and are among them', () => {
    const paths = [...routes(GamingDevicesController), ...routes(GamingHubsController)].map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining([':id/tv/pair', ':id/tv/cancel', ':hubId/tv/add']));
  });
});
