import { validSocketPacket } from './socket-packet-validator';

describe('validSocketPacket', () => {
  it('accepts normal game input, binary paint and acknowledgements', () => {
    expect(
      validSocketPacket(['camo.move', { x: 1, z: -2, yaw: 0.5, seq: 4 }]),
    ).toBe(true);
    expect(
      validSocketPacket([
        'camo.paint',
        { bytes: new Uint8Array(1024) },
        () => undefined,
      ]),
    ).toBe(true);
  });

  it('rejects non-finite numbers, excessive depth and dangerous keys', () => {
    expect(
      validSocketPacket(['camo.move', { x: Number.POSITIVE_INFINITY }]),
    ).toBe(false);
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) nested = { next: nested };
    expect(validSocketPacket(['lobby.social.command', nested])).toBe(false);
    expect(
      validSocketPacket([
        'chat.typing',
        Object.create(null, {
          constructor: { value: 'bad', enumerable: true },
        }) as unknown,
      ]),
    ).toBe(false);
  });

  it('rejects oversized strings, binaries and unexpected packet arguments', () => {
    expect(
      validSocketPacket(['camo.report', { note: 'x'.repeat(32 * 1024 + 1) }]),
    ).toBe(false);
    expect(
      validSocketPacket([
        'camo.paint',
        { bytes: new Uint8Array(48 * 1024 + 1) },
      ]),
    ).toBe(false);
    expect(validSocketPacket(['camo.move', {}, {}])).toBe(false);
  });

  it('validates WebRTC session descriptions and ICE candidates', () => {
    expect(
      validSocketPacket([
        'voice.offer',
        { sdp: { type: 'offer', sdp: 'v=0' } },
      ]),
    ).toBe(true);
    expect(validSocketPacket(['voice.offer', { sdp: { type: 'offer' } }])).toBe(
      false,
    );
    expect(
      validSocketPacket([
        'voice.offer',
        {
          squadId: 's1',
          toUserId: 'u1',
          sdp: { type: 'offer', sdp: 'v=0' },
          extra: true,
        },
      ]),
    ).toBe(false);
    expect(
      validSocketPacket([
        'call.ice',
        {
          candidate: {
            candidate: 'candidate:1',
            sdpMid: '0',
            sdpMLineIndex: 0,
          },
        },
      ]),
    ).toBe(true);
    expect(
      validSocketPacket([
        'call.ice',
        { candidate: { candidate: 'x'.repeat(8_193) } },
      ]),
    ).toBe(false);
  });

  it('bounds identifier fields before database-backed handlers see them', () => {
    expect(
      validSocketPacket([
        'chat.typing',
        { threadId: 'x'.repeat(129), typing: true },
      ]),
    ).toBe(false);
    expect(
      validSocketPacket([
        'chat.typing',
        { threadId: 'thread-1', typing: true },
      ]),
    ).toBe(true);
  });
});
