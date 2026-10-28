import {
  isAuthError,
  modelFromDeviceId,
  parseShellyFrame,
  safeConfigParams,
  shellyRequest,
  switchSetParams,
} from './shelly-protocol';

describe('shelly protocol', () => {
  it('reads full and partial status for every switch channel', () => {
    const full = parseShellyFrame(
      JSON.stringify({
        src: 'shellyplugsg3-a1b2c3d4e5f6',
        dst: 'ws',
        method: 'NotifyFullStatus',
        params: {
          'switch:0': { id: 0, output: true, apower: 92.5, source: 'init' },
          sys: {},
        },
      }),
    );
    expect(full).toEqual({
      kind: 'status',
      deviceId: 'shellyplugsg3-a1b2c3d4e5f6',
      full: true,
      switches: [{ channel: 0, output: true, powerW: 92.5, source: 'init' }],
    });
    const partial = parseShellyFrame(
      JSON.stringify({
        src: 'shellypro4pm-x1',
        method: 'NotifyStatus',
        params: { 'switch:2': { apower: 3 } },
      }),
    );
    expect(partial).toMatchObject({
      full: false,
      switches: [{ channel: 2, powerW: 3 }],
    });
  });

  it('matches responses addressed to us, including errors', () => {
    expect(
      parseShellyFrame(
        JSON.stringify({
          id: 7,
          src: 'shellyplusplugs-1',
          dst: 'matchena',
          result: { was_on: false },
        }),
      ),
    ).toEqual({
      kind: 'response',
      deviceId: 'shellyplusplugs-1',
      id: 7,
      result: { was_on: false },
    });
    const err = parseShellyFrame(
      JSON.stringify({
        id: 8,
        src: 'shellyplusplugs-1',
        dst: 'matchena',
        error: { code: 401, message: 'auth' },
      }),
    );
    expect(err).toMatchObject({ error: { code: 401 } });
    expect(isAuthError(err.kind === 'response' ? err.error : undefined)).toBe(
      true,
    );
  });

  it('ignores junk, foreign ids and other methods', () => {
    for (const raw of [
      'nope',
      '[]',
      '{}',
      JSON.stringify({ src: '../../etc', method: 'NotifyStatus' }),
      JSON.stringify({
        src: 'shellyplug-1',
        method: 'NotifyEvent',
        params: {},
      }),
      JSON.stringify({
        id: 1,
        src: 'shellyplug-1',
        dst: 'someone-else',
        result: {},
      }),
    ])
      expect(parseShellyFrame(raw)).toEqual({ kind: 'ignored' });
  });

  it('builds requests', () => {
    expect(
      JSON.parse(shellyRequest(3, 'Switch.Set', switchSetParams(0, true, 600))),
    ).toEqual({
      jsonrpc: '2.0',
      id: 3,
      src: 'matchena',
      method: 'Switch.Set',
      params: { id: 0, on: true, toggle_after: 600 },
    });
    expect(switchSetParams(1, false, null)).toEqual({ id: 1, on: false });
    expect(safeConfigParams(0)).toEqual({
      id: 0,
      config: { initial_state: 'off' },
    });
    expect(modelFromDeviceId('shellyplugsg3-a1b2c3')).toBe('shellyplugsg3');
  });
});
