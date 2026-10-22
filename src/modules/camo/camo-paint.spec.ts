import {
  MAX_BATCH_STROKES,
  MAX_STAMPS_PER_PLAYER,
  MAX_STROKES_PER_PLAYER,
  MAX_WIRE_BYTES,
  STAMP_TEXELS,
  acceptStrokes,
  decodeStrokes,
  emptyPaintBook,
  encodeStrokes,
  estimateCamo,
  strokeBytes,
  type WireStroke,
} from './camo-paint';

const brush = (over: Partial<WireStroke> = {}): WireStroke => ({
  kind: 'brush', x: 100, y: 800, z: 50, r: 30, rgb: 0x336699, rough: 120, hard: 140, nx: 0, ny: 0, nz: 127, seed: 7, ...over,
});
const stamp = (): WireStroke => ({
  ...brush({ kind: 'stamp' }),
  patch: { texels: new Uint8Array(STAMP_TEXELS * STAMP_TEXELS * 4).fill(150), cx: 1500, cy: 800, cz: 0, fx: -127, fy: 0, fz: 0, ux: 0, uy: 127, uz: 0, tan: 68 },
});

describe('camo paint wire', () => {
  it('round-trips a batch including a stamp', () => {
    const list = [brush(), stamp(), brush({ kind: 'fill', r: 1, x: 0, y: 0, z: 0 })];
    const back = decodeStrokes(encodeStrokes(list))!;
    expect(back.length).toBe(3);
    expect(back[1].patch?.tan).toBe(68);
    expect(back[0].rgb).toBe(0x336699);
  });

  it('rejects truncated, oversized and unknown payloads', () => {
    const bytes = encodeStrokes([brush(), brush()]);
    expect(decodeStrokes(bytes.slice(0, bytes.length - 3))).toBeNull();
    expect(decodeStrokes(new Uint8Array([1]))).toBeNull();
    const big = new Uint8Array(MAX_WIRE_BYTES + 1000);
    expect(decodeStrokes(big)).toBeNull();
    const many = encodeStrokes(Array.from({ length: MAX_BATCH_STROKES + 1 }, () => brush()));
    expect(decodeStrokes(many)).toBeNull();
    const bad = encodeStrokes([brush()]);
    bad[2] = 9;
    expect(decodeStrokes(bad)).toBeNull();
  });

  it('enforces 1500 strokes, 24 stamps and the 40 KB budget per player', () => {
    const book = emptyPaintBook();
    let n = 0;
    while (acceptStrokes(book, [brush({ y: 700 + (n % 50) })]).accepted.length) n++;
    expect(n).toBe(MAX_STROKES_PER_PLAYER);
    expect(book.bytes).toBeLessThanOrEqual(MAX_WIRE_BYTES);
    const b2 = emptyPaintBook();
    let s = 0;
    while (acceptStrokes(b2, [stamp()]).accepted.length) s++;
    expect(s).toBe(MAX_STAMPS_PER_PLAYER);
    expect(b2.bytes).toBe(2 + s * strokeBytes(stamp()));
  });

  it('drops strokes far outside the hiding box and stamps without a patch', () => {
    const book = emptyPaintBook();
    const v = acceptStrokes(book, [brush({ x: 5000 }), brush({ y: -5000 }), { ...stamp(), patch: undefined }, brush()]);
    expect(v.accepted.length).toBe(1);
    expect(v.rejected).toBe(3);
  });

  it('rates a matching fill as a better camouflage than a clashing one, and unpainted as none', () => {
    const wall = 0x808080;
    const match = emptyPaintBook();
    acceptStrokes(match, [brush({ kind: 'fill', rgb: 0x838281, r: 1 })]);
    const clash = emptyPaintBook();
    acceptStrokes(clash, [brush({ kind: 'fill', rgb: 0xff0000, r: 1 })]);
    expect(estimateCamo(match, wall)).toBeGreaterThan(0.9);
    expect(estimateCamo(clash, wall)).toBeLessThan(0.3);
    expect(estimateCamo(emptyPaintBook(), wall)).toBe(0);
  });
});
