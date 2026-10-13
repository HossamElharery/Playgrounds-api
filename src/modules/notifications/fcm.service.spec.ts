import { FcmService, buildCallMessage, buildMessage, parseServiceAccount } from './fcm.service';

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
