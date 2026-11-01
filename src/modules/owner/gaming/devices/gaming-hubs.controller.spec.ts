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
