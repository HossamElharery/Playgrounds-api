import { DeviceLinksService, hashDeviceId } from './device-links.service';

function make(rows: { devices?: any[]; tokens?: any[]; sharedDevices?: any[]; sharedTokens?: any[] } = {}) {
  const prisma: any = {
    userDevice: {
      upsert: jest.fn(async () => undefined),
      findMany: jest.fn(async (args: any) => (args.where.userId?.not ? rows.sharedDevices ?? [] : rows.devices ?? [])),
    },
    deviceToken: {
      findMany: jest.fn(async (args: any) => (args.where.userId?.not ? rows.sharedTokens ?? [] : rows.tokens ?? [])),
    },
  };
  return { svc: new DeviceLinksService(prisma), prisma };
}

describe('DeviceLinksService', () => {
  it('only accepts a well-formed device id and stores it hashed', async () => {
    expect(hashDeviceId('short')).toBeNull();
    expect(hashDeviceId('has spaces and !!! odd chars in it ....')).toBeNull();
    const h = hashDeviceId('abcdefghijklmnop1234');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    const { svc, prisma } = make();
    await svc.record('u1', 'abcdefghijklmnop1234');
    expect((prisma.userDevice.upsert.mock.calls[0] as any[])[0].create).toEqual({ userId: 'u1', deviceHash: h });
    await svc.record('u1', 'not valid');
    expect(prisma.userDevice.upsert).toHaveBeenCalledTimes(1);
  });

  it('writes the same account/device pair at most once in a while', async () => {
    const { svc, prisma } = make();
    await svc.record('u1', 'abcdefghijklmnop1234');
    await svc.record('u1', 'abcdefghijklmnop1234');
    expect(prisma.userDevice.upsert).toHaveBeenCalledTimes(1);
  });

  it('links accounts that share a device or a push token', async () => {
    const { svc } = make({
      devices: [{ deviceHash: 'd1' }],
      tokens: [{ token: 't1' }],
      sharedDevices: [{ userId: 'alt1' }],
      sharedTokens: [{ userId: 'alt2' }],
    });
    expect([...(await svc.linkedIds('u1'))].sort()).toEqual(['alt1', 'alt2']);
    expect(await svc.areLinked('u1', 'alt1')).toBe(true);
    expect(await svc.areLinked('u1', 'stranger')).toBe(false);
  });

  it('an account is always linked to itself and an account with no devices links to nobody', async () => {
    const { svc } = make();
    expect(await svc.areLinked('u1', 'u1')).toBe(true);
    expect((await svc.linkedIds('u1')).size).toBe(0);
  });
});
