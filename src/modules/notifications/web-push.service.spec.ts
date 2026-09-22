import * as webpush from 'web-push';
import { WebPushService } from './web-push.service';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

function configService(vars: Record<string, string | undefined>) {
  return { get: (key: string) => vars[key] } as never;
}

function prisma() {
  const rows: any[] = [];
  return {
    rows,
    pushSubscription: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = rows.find((r) => r.endpoint === where.endpoint);
        if (existing) Object.assign(existing, update);
        else rows.push({ id: `s${rows.length + 1}`, ...create, lastUsedAt: new Date() });
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].userId === where.userId && rows[i].endpoint === where.endpoint) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      }),
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => r.userId === where.userId)),
      update: jest.fn(async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data)),
      delete: jest.fn(async ({ where }: any) => {
        const i = rows.findIndex((r) => r.id === where.id);
        if (i >= 0) rows.splice(i, 1);
      }),
    },
  } as never;
}

describe('WebPushService — off by default', () => {
  it('is not configured, publicKey is null, subscribe is refused, send is a no-op', async () => {
    const svc = new WebPushService(prisma(), configService({}));
    expect(svc.configured()).toBe(false);
    expect(svc.publicKey()).toBeNull();
    await expect(
      svc.subscribe('u1', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }),
    ).rejects.toBeDefined();
    await expect(svc.send('u1', 'Title', 'Body')).resolves.toBeUndefined();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});

describe('WebPushService — configured', () => {
  const env = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'admin@matchena.com' };

  it('sets VAPID details once at construction and exposes the public key', () => {
    (webpush.setVapidDetails as jest.Mock).mockClear();
    const svc = new WebPushService(prisma(), configService(env));
    expect(svc.configured()).toBe(true);
    expect(svc.publicKey()).toBe('pub');
    expect(webpush.setVapidDetails).toHaveBeenCalledWith('mailto:admin@matchena.com', 'pub', 'priv');
  });

  it('subscribing twice on the same endpoint updates it instead of duplicating', async () => {
    const db = prisma();
    const svc = new WebPushService(db, configService(env));
    await svc.subscribe('u1', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } });
    await svc.subscribe('u1', { endpoint: 'https://push.example/1', keys: { p256dh: 'a2', auth: 'b2' } });
    expect((db as any).rows).toHaveLength(1);
    expect((db as any).rows[0].p256dh).toBe('a2');
  });

  it('unsubscribe only removes the caller’s own endpoint', async () => {
    const db = prisma();
    const svc = new WebPushService(db, configService(env));
    await svc.subscribe('u1', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } });
    await svc.unsubscribe('u2', 'https://push.example/1');
    expect((db as any).rows).toHaveLength(1);
    await svc.unsubscribe('u1', 'https://push.example/1');
    expect((db as any).rows).toHaveLength(0);
  });

  it('sends to every subscription of the user with exactly the given title/body — nothing richer', async () => {
    const db = prisma();
    const svc = new WebPushService(db, configService(env));
    await svc.subscribe('u1', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } });
    await svc.subscribe('u1', { endpoint: 'https://push.example/2', keys: { p256dh: 'c', auth: 'd' } });
    (webpush.sendNotification as jest.Mock).mockResolvedValue(undefined);
    await svc.send('u1', 'New booking', 'Ahmed booked court 1', '/owner/bookings');
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    const payload = JSON.parse((webpush.sendNotification as jest.Mock).mock.calls[0][1]);
    expect(payload).toEqual({ title: 'New booking', body: 'Ahmed booked court 1', url: '/owner/bookings' });
  });

  it('drops a subscription the browser reports as gone (404/410), keeps others', async () => {
    const db = prisma();
    const svc = new WebPushService(db, configService(env));
    await svc.subscribe('u1', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } });
    await svc.subscribe('u1', { endpoint: 'https://push.example/2', keys: { p256dh: 'c', auth: 'd' } });
    (webpush.sendNotification as jest.Mock)
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
      .mockResolvedValueOnce(undefined);
    await svc.send('u1', 'Title');
    expect((db as any).rows).toHaveLength(1);
  });

  it('a transient failure (not 404/410) is logged, not deleted', async () => {
    const db = prisma();
    const svc = new WebPushService(db, configService(env));
    await svc.subscribe('u1', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } });
    (webpush.sendNotification as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('down'), { statusCode: 503 }));
    await svc.send('u1', 'Title');
    expect((db as any).rows).toHaveLength(1);
  });
});
