import 'reflect-metadata';
import {
  GamingHubClaimController,
  GamingHubsController,
} from './gaming-hubs.controller';

const route = (proto: object, name: string) => ({
  path: Reflect.getMetadata(
    'path',
    (proto as Record<string, object>)[name],
  ) as string,
  method: Reflect.getMetadata(
    'method',
    (proto as Record<string, object>)[name],
  ) as number,
});

describe('Hub routes are really registered (the service tests do not prove that)', () => {
  const owner = GamingHubsController.prototype;
  it.each([
    ['code', 'code'],
    ['scan', ':hubId/scan'],
    ['update', ':hubId/update'],
    ['psnUrl', ':hubId/psn-url'],
    ['psn', ':hubId/psn'],
    ['psnSignin', ':hubId/psn/signin'],
    ['psnStatus', ':hubId/psn/status'],
    ['psnCancel', ':hubId/psn/cancel'],
  ])('%s -> %s', (method, path) => {
    expect(route(owner, method).path).toBe(path);
  });
  it('public endpoints exist: claim, latest, install.sh, download/:file', () => {
    const p = GamingHubClaimController.prototype;
    expect(route(p, 'claim').path).toBe('claim');
    expect(route(p, 'latest').path).toBe('latest');
    expect(route(p, 'installScript').path).toBe('install.sh');
    expect(route(p, 'download').path).toBe('download/:file');
  });
});

import { commandFrom } from './gaming-devices.dto';

describe('DELETE accepts the command as a body or as a query string', () => {
  const ids = {
    venueId: '0681db3e-9ca8-4c92-81da-2034c87c7e63',
    requestKey: '3f2b1c0e-8f6a-4b0e-9d0a-6a3c1f2e4b5d',
  };
  it('body, query, and both', () => {
    expect(commandFrom({}, ids)).toMatchObject(ids);
    expect(commandFrom(ids, undefined)).toMatchObject(ids);
    expect(
      commandFrom({ venueId: ids.venueId }, { requestKey: ids.requestKey }),
    ).toMatchObject(ids);
  });
  it('rejects anything that is not a venue id plus a v4 request key, and ignores extra fields', () => {
    expect(() => commandFrom({}, {})).toThrow();
    expect(() => commandFrom({}, { ...ids, requestKey: 'nope' })).toThrow();
    expect(() => commandFrom({}, { ...ids, venueId: '1' })).toThrow();
    expect(commandFrom({}, { ...ids, extra: 'x' })).toEqual(
      expect.not.objectContaining({ extra: 'x' }),
    );
  });
});
