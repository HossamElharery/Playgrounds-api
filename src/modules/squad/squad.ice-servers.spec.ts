import { createHmac } from 'crypto';
import { SquadService } from './squad.service';

describe('SquadService.iceServers', () => {
  function service(env: Record<string, string>) {
    const config: any = { get: (k: string) => env[k] };
    return new SquadService({} as any, {} as any, {} as any, {} as any, config);
  }

  afterEach(() => jest.useRealTimers());

  it('returns STUN only while TURN_URLS is empty (current production)', () => {
    const { iceServers } = service({}).iceServers('u1');
    expect(iceServers.map((s) => s.urls)).toEqual([
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
    ]);
  });

  it('issues short-lived HMAC credentials coturn can verify with TURN_SECRET', () => {
    jest.useFakeTimers({ now: new Date('2026-09-26T00:00:00Z') });
    const { iceServers } = service({
      TURN_URLS:
        'turn:turn.matchena.com:3478?transport=udp, turns:turn.matchena.com:5349',
      TURN_SECRET: 's3cret',
      TURN_TTL_SECONDS: '3600',
      TURN_USERNAME: 'ignored',
    }).iceServers('u1');
    const turn = iceServers.filter((s) => s.urls.startsWith('turn'));
    expect(turn).toHaveLength(2);
    const expiry = Date.parse('2026-09-26T01:00:00Z') / 1000;
    expect(turn[0].username).toBe(`${expiry}:u1`);
    expect(turn[0].credential).toBe(
      createHmac('sha1', 's3cret').update(`${expiry}:u1`).digest('base64'),
    );
    expect(turn[1]).toEqual({
      ...turn[0],
      urls: 'turns:turn.matchena.com:5349',
    });
  });

  it('defaults the credential lifetime to 12 hours', () => {
    jest.useFakeTimers({ now: new Date('2026-09-26T00:00:00Z') });
    const { iceServers } = service({
      TURN_URLS: 'turn:t:3478',
      TURN_SECRET: 'x',
    }).iceServers('u1');
    const expiry = Number(iceServers[2].username!.split(':')[0]);
    expect(expiry - Date.parse('2026-09-26T00:00:00Z') / 1000).toBe(12 * 3600);
  });

  it('keeps static TURN credentials working without a secret', () => {
    const { iceServers } = service({
      TURN_URLS: 'turn:t:3478',
      TURN_USERNAME: 'user',
      TURN_CREDENTIAL: 'pass',
    }).iceServers('u1');
    expect(iceServers[2]).toEqual({
      urls: 'turn:t:3478',
      username: 'user',
      credential: 'pass',
    });
  });

  it('forces relay-only only with TURN_FORCE_RELAY=true and a TURN server', () => {
    expect(
      service({ TURN_FORCE_RELAY: 'true' }).iceServers('u1').iceTransportPolicy,
    ).toBeUndefined();
    const on = service({
      TURN_URLS: 'turn:t:3478',
      TURN_SECRET: 'x',
      TURN_FORCE_RELAY: 'true',
    });
    expect(on.iceServers('u1').iceTransportPolicy).toBe('relay');
    const off = service({
      TURN_URLS: 'turn:t:3478',
      TURN_SECRET: 'x',
      TURN_FORCE_RELAY: 'yes',
    });
    expect(off.iceServers('u1').iceTransportPolicy).toBeUndefined();
  });
});
