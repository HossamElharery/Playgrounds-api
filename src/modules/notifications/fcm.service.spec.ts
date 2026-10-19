import { FcmService, buildCallMessage, buildMessage, buildNativeCallCancel, buildNativeCallMessage, isNativeCallDevice, parseServiceAccount } from './fcm.service';

jest.mock('google-auth-library', () => ({
  JWT: jest.fn().mockImplementation(() => ({
    getAccessToken: jest.fn().mockResolvedValue({ token: 'access-token' }),
  })),
}));

const account = {
  project_id: 'matchena-app',
  client_email: 'push@matchena-app.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
};

describe('FcmService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function build(raw: string | undefined) {
    const prisma = {
      deviceToken: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'd1', token: 'tok-ok', platform: 'ios' },
          { id: 'd2', token: 'tok-gone', platform: 'android' },
        ]),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new FcmService(prisma as never, { get: () => raw } as never);
    return { service, prisma };
  }

  it('parses raw or base64 service-account JSON and restores key newlines', () => {
    const raw = JSON.stringify(account);
    expect(parseServiceAccount(raw)?.private_key).toContain('\nabc\n');
    expect(parseServiceAccount(Buffer.from(raw).toString('base64'))?.project_id).toBe('matchena-app');
    expect(parseServiceAccount('{"project_id":"x"}')).toBeNull();
    expect(parseServiceAccount('')).toBeNull();
  });

  it('builds a message with deep link data, an Android channel and an iOS sound', () => {
    const msg = buildMessage('t', { title: 'Booked', body: null, deepLink: '/app/bookings' });
    expect(msg).toMatchObject({
      token: 't',
      notification: { title: 'Booked', body: 'Booked' },
      data: { deepLink: '/app/bookings' },
      android: { notification: { channel_id: 'matchena_default' } },
      apns: { payload: { aps: { sound: 'default' } } },
    });
  });

  it('is a no-op without configuration', async () => {
    const { service, prisma } = build(undefined);
    await service.sendToUser('u1', { title: 'x' });
    expect(service.configured()).toBe(false);
    expect(prisma.deviceToken.findMany).not.toHaveBeenCalled();
  });

  it('sends to every device and drops tokens FCM reports as unregistered', async () => {
    const { service, prisma } = build(JSON.stringify(account));
    const fetchMock = jest.fn().mockImplementation((_url: string, init: { body: string }) =>
      Promise.resolve(
        init.body.includes('tok-gone')
          ? { ok: false, status: 404, text: () => Promise.resolve('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}') }
          : { ok: true, status: 200, text: () => Promise.resolve('{}') },
      ),
    );
    global.fetch = fetchMock as never;
    await service.sendToUser('u1', { title: 'Hi' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://fcm.googleapis.com/v1/projects/matchena-app/messages:send');
    expect(prisma.deviceToken.delete).toHaveBeenCalledWith({ where: { id: 'd2' } });
    expect(prisma.deviceToken.delete).toHaveBeenCalledTimes(1);
  });

  it('builds a ringing call push: call channel, short life, time-sensitive, replaceable by its tag', () => {
    const msg = buildCallMessage('t', { callId: 'c1', kind: 'ring', title: 'Call from Mona', body: 'Tap to answer', deepLink: '/ar/owner' }, 1_000_000_000_000);
    expect(msg).toMatchObject({
      token: 't',
      notification: { title: 'Call from Mona', body: 'Tap to answer' },
      data: { type: 'call', kind: 'ring', callId: 'c1', deepLink: '/ar/owner' },
      android: {
        priority: 'HIGH',
        ttl: '30s',
        collapse_key: 'call:c1',
        notification: { channel_id: 'matchena_calls', tag: 'call:c1', notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC' },
      },
      apns: {
        headers: { 'apns-priority': '10', 'apns-collapse-id': 'c1', 'apns-expiration': '1000000030' },
        payload: { aps: { sound: 'matchena_ring.wav', 'interruption-level': 'time-sensitive' } },
      },
    });
  });

  it('builds the missed-call push so it replaces the ring and stays for a day', () => {
    const msg = buildCallMessage('t', { callId: 'c1', kind: 'missed', title: 'Missed call', deepLink: '/ar/owner' });
    expect(msg.android.ttl).toBe('86400s');
    expect(msg.android.notification).toMatchObject({ channel_id: 'matchena_default', tag: 'call:c1' });
    expect(msg.android.collapse_key).toBe('call:c1');
    expect(msg.apns.headers).not.toHaveProperty('apns-expiration');
    expect(msg.apns.payload.aps).toEqual({ sound: 'default', 'interruption-level': 'active' });
    expect(msg.notification.body).toBe('Missed call');
  });

  it('sends a call push to every device through the same delivery path', async () => {
    const { service } = build(JSON.stringify(account));
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    global.fetch = fetchMock as never;
    await service.sendCall('u1', { callId: 'c1', kind: 'ring', title: 'Call', deepLink: '/ar/owner' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { message: { data: { type: string } } };
    expect(sent.message.data.type).toBe('call');
  });
});

describe('sendWithRetry', () => {
  const { sendWithRetry } = jest.requireActual('./fcm.service') as typeof import('./fcm.service');
  const res = (status: number) => ({ ok: status < 400, status }) as Response;

  it('retries transient FCM failures and returns the first good answer', async () => {
    const send = jest.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200));
    await expect(sendWithRetry(send, [1, 1])).resolves.toMatchObject({ status: 200 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('does not retry a final client error such as an unregistered token', async () => {
    const send = jest.fn().mockResolvedValue(res(404));
    await expect(sendWithRetry(send, [1, 1])).resolves.toMatchObject({ status: 404 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('gives up after the bounded number of attempts and surfaces a network error', async () => {
    const send = jest.fn().mockRejectedValue(new Error('socket hang up'));
    await expect(sendWithRetry(send, [1, 1])).rejects.toThrow('socket hang up');
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe('native call push', () => {
  const msg = { callId: 'c1', kind: 'ring' as const, title: 'Call from Sara', body: 'Tap to answer', deepLink: '/ar/owner' };

  it('is data-only for the Android build that has the native call screen', () => {
    const m = buildNativeCallMessage('tok', msg) as Record<string, unknown>;
    expect(m['notification']).toBeUndefined();
    expect(m['data']).toMatchObject({ type: 'call', kind: 'ring', callId: 'c1', title: 'Call from Sara' });
    expect(m['android']).toMatchObject({ priority: 'HIGH', ttl: '30s', collapse_key: 'call:c1' });
  });

  it('cancels with the same collapse key so an undelivered ring is replaced', () => {
    expect(buildNativeCallCancel('tok', 'c1')).toMatchObject({ data: { kind: 'cancel', callId: 'c1' }, android: { collapse_key: 'call:c1' } });
  });

  it('only Android builds that registered the capability get it; everyone else keeps the notification', () => {
    expect(isNativeCallDevice({ platform: 'android', capabilities: ['native-call-ui'] })).toBe(true);
    expect(isNativeCallDevice({ platform: 'android', capabilities: [] })).toBe(false);
    expect(isNativeCallDevice({ platform: 'ios', capabilities: ['native-call-ui'] })).toBe(false);
    expect(isNativeCallDevice({ platform: 'android', capabilities: undefined as never })).toBe(false);
  });

  it('sendCall picks the right message per device and counts accepted sends', async () => {
    const sent: any[] = [];
    (global as any).fetch = jest.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body).message);
      return { ok: true, status: 200, text: async () => '' };
    });
    const prisma = {
      deviceToken: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'a', token: 'new-android', platform: 'android', capabilities: ['native-call-ui'] },
          { id: 'b', token: 'old-android', platform: 'android', capabilities: [] },
          { id: 'c', token: 'iphone', platform: 'ios', capabilities: [] },
        ]),
        delete: jest.fn(),
      },
    };
    const service = new FcmService(prisma as never, { get: () => JSON.stringify(account) } as never);
    const accepted = await service.sendCall('u', msg);
    expect(accepted).toBe(3);
    expect(sent.find((m) => m.token === 'new-android').notification).toBeUndefined();
    expect(sent.find((m) => m.token === 'old-android').notification).toBeDefined();
    expect(sent.find((m) => m.token === 'iphone').notification).toBeDefined();
    sent.length = 0;
    expect(await service.sendCallCancel('u', 'c1')).toBe(1); // only the capable device
    expect(sent.map((m) => m.token)).toEqual(['new-android']);
  });
});
