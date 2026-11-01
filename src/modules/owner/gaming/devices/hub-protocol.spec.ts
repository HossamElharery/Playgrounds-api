import {
  formatClaimCode,
  newClaimCode,
  normalizeClaimCode,
} from './gaming-hubs.service';
import { hubRequest, parseHubFrame } from './hub-protocol';

describe('hub protocol frames', () => {
  it('parses hello with defaults and trims hostile input', () => {
    expect(
      parseHubFrame(
        JSON.stringify({
          t: 'hello',
          hubVersion: '1.2.3',
          platform: 'win32',
          hostname: 'PC\u0000-1',
          psnLinked: true,
        }),
      ),
    ).toEqual({
      kind: 'hello',
      hubVersion: '1.2.3',
      platform: 'win32',
      hostname: 'PC-1',
      psnLinked: true,
    });
    expect(parseHubFrame('{"t":"hello"}')).toMatchObject({
      kind: 'hello',
      hubVersion: 'unknown',
      psnLinked: false,
    });
  });

  it('keeps valid consoles, drops malformed and duplicate ones, and caps the list', () => {
    const good = {
      id: 'A1B2C3',
      name: 'PS5-1',
      type: 'PS5',
      address: '192.168.1.5',
      state: 'awake',
      paired: true,
    };
    const frame = parseHubFrame(
      JSON.stringify({
        t: 'consoles',
        list: [
          good,
          good,
          { ...good, id: 'x' },
          { ...good, id: 'OKAY1', type: 'XBOX' },
          {
            ...good,
            id: 'OKAY2',
            state: 'weird',
            address: 'not-an-ip',
            standbyAt: 'nope',
          },
          null,
          'str',
        ],
      }),
    );
    expect(frame.kind).toBe('consoles');
    if (frame.kind !== 'consoles') return;
    expect(frame.list.map((c) => c.id)).toEqual(['A1B2C3', 'OKAY2']);
    expect(frame.list[1]).toMatchObject({
      state: 'unreachable',
      address: '',
      paired: true,
      standbyAt: null,
    });
    const many = parseHubFrame(
      JSON.stringify({
        t: 'consoles',
        list: Array.from({ length: 200 }, (_, i) => ({
          ...good,
          id: `CON${i}1`,
        })),
      }),
    );
    expect(many.kind === 'consoles' && many.list.length).toBe(64);
  });

  it('parses responses strictly and ignores everything else', () => {
    expect(
      parseHubFrame('{"t":"res","id":4,"ok":true,"data":{"a":1}}'),
    ).toEqual({ kind: 'response', id: 4, ok: true, data: { a: 1 } });
    expect(
      parseHubFrame(
        '{"t":"res","id":4,"ok":false,"code":"PIN_WRONG","message":"no"}',
      ),
    ).toMatchObject({ ok: false, code: 'PIN_WRONG' });
    for (const bad of [
      '',
      'nope',
      '[]',
      '{"t":"res","id":"4","ok":true}',
      '{"t":"res","id":4}',
      '{"t":"x"}',
      '{"t":"consoles"}',
    ])
      expect(parseHubFrame(bad)).toEqual({ kind: 'ignored' });
  });

  it('builds requests', () => {
    expect(JSON.parse(hubRequest(7, 'wake', { consoleId: 'A' }))).toEqual({
      t: 'req',
      id: 7,
      op: 'wake',
      args: { consoleId: 'A' },
    });
  });
});

describe('connect codes', () => {
  it('are 8 unambiguous characters, formatted for reading, and tolerant when typed', () => {
    for (let i = 0; i < 200; i++)
      expect(newClaimCode()).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/);
    expect(formatClaimCode('ABCD2345')).toBe('ABCD-2345');
    expect(normalizeClaimCode(' abcd-2345 ')).toBe('ABCD2345');
    expect(normalizeClaimCode('ab cd\t23.45')).toBe('ABCD2345');
  });
});
