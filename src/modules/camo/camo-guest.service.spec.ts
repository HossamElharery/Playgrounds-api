import { CamoGuestService, CAMO_GUEST_RETENTION_MS } from './camo-guest.service';
import { CAMO_DEFAULTS } from './camo-settings.service';

function make(flags: Record<string, string> = { CAMO_ENABLED: 'true' }, turnstile: { enabled: boolean; verify?: jest.Mock } = { enabled: false }) {
  const user = { create: jest.fn(async ({ data }: any) => ({ id: 'u1', ...data })), findMany: jest.fn(async (_args?: any) => [{ id: 'old' }]), findFirst: jest.fn(async () => ({ id: 'old' })), delete: jest.fn(async () => undefined) };
  const prisma: any = { user, friendship: { deleteMany: jest.fn() }, $transaction: jest.fn(async (fn: any) => fn({ user, friendship: prisma.friendship })) };
  const svc = new CamoGuestService(
    { get: (k: string) => flags[k] } as any,
    prisma,
    { enabled: turnstile.enabled, verify: turnstile.verify ?? jest.fn(async () => 'ok') } as any,
    { load: async () => CAMO_DEFAULTS, flagSource: (env: any) => env } as any,
  );
  return { svc, prisma, user };
}

describe('CamoGuestService', () => {
  it('is 404 while the flag is off', async () => {
    const { svc } = make({});
    await expect(svc.create({ ip: '1.1.1.1' })).rejects.toMatchObject({ status: 404 });
  });

  it('creates a camo_play guest with a cleaned name or a default «ضيف 1234»', async () => {
    const { svc, user } = make();
    const a = await svc.create({ name: '  Ali‮   Hassan  ', lang: 'en', ip: '1.1.1.1' });
    expect(a.name).toBe('Ali Hassan');
    expect((user.create.mock.calls[0] as any[])[0].data).toMatchObject({ isGuest: true, guestSource: 'camo_play' });
    const b = await svc.create({ ip: '1.1.1.2' });
    expect(b.name).toMatch(/^ضيف \d{4}$/);
  });

  it('refuses a failed Turnstile challenge but lets a verifier outage through (fail-open like the assistant)', async () => {
    const failed = make({ CAMO_ENABLED: 'true' }, { enabled: true, verify: jest.fn(async () => 'failed') });
    await expect(failed.svc.create({ ip: '2.2.2.2', turnstileToken: 'x' })).rejects.toMatchObject({ status: 403 });
    const outage = make({ CAMO_ENABLED: 'true' }, { enabled: true, verify: jest.fn(async () => 'error') });
    await expect(outage.svc.create({ ip: '2.2.2.2', turnstileToken: 'x' })).resolves.toBeDefined();
  });

  it('limits guests per IP (10/day) and per device (3/day)', async () => {
    const { svc } = make();
    for (let i = 0; i < 3; i++) await svc.create({ ip: '9.9.9.9', deviceId: 'dev' });
    await expect(svc.create({ ip: '9.9.9.8', deviceId: 'dev' })).rejects.toMatchObject({ status: 429 });
    for (let i = 0; i < 10; i++) await svc.create({ ip: '7.7.7.7' });
    await expect(svc.create({ ip: '7.7.7.7' })).rejects.toMatchObject({ status: 429 });
    await expect(svc.create({ ip: '7.7.7.6' })).resolves.toBeDefined();
  });

  it('the daily sweep targets only unconverted camo_play guests idle 30 days with no bookings and no squads', async () => {
    const { svc, user } = make();
    const now = Date.now();
    const removed = await svc.sweep(now);
    expect(removed).toBe(1);
    const where = (user.findMany.mock.calls[0] as any[])[0].where;
    expect(where).toMatchObject({ isGuest: true, guestSource: 'camo_play', bookings: { none: {} }, squadMemberships: { none: {} } });
    expect(where.createdAt.lt.getTime()).toBe(now - CAMO_GUEST_RETENTION_MS);
    expect(user.delete).toHaveBeenCalledWith({ where: { id: 'old', isGuest: true } });
  });
});
