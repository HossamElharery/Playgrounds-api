/**
 * Paint on the wire (section 6.3): ranked, bounded and counted by the server, never rendered by it.
 * The byte format is the client's `camo-paint-codec.ts`; the limits mirror `camo-types.ts` and are checked by the
 * shared limits spec on both sides.
 */
export const STAMP_TEXELS = 16;
export const MAX_STROKES_PER_PLAYER = 1500;
export const MAX_STAMPS_PER_PLAYER = 24;
export const MAX_WIRE_BYTES = 40 * 1024;
/** One batch carries at most this many strokes (a 250 ms flush of a fast finger). */
export const MAX_BATCH_STROKES = 60;

export type StrokeKind = 'brush' | 'spray' | 'stamp' | 'fill';
const KINDS: readonly StrokeKind[] = ['brush', 'spray', 'stamp', 'fill'];
const BASE_BYTES = 1 + 6 + 1 + 3 + 1 + 1 + 3 + 2;
const PATCH_BYTES = 13 + STAMP_TEXELS * STAMP_TEXELS * 4;

export interface WireStroke {
  kind: StrokeKind;
  x: number;
  y: number;
  z: number;
  r: number;
  rgb: number;
  rough: number;
  hard: number;
  nx: number;
  ny: number;
  nz: number;
  seed: number;
  patch?: {
    texels: Uint8Array;
    cx: number;
    cy: number;
    cz: number;
    fx: number;
    fy: number;
    fz: number;
    ux: number;
    uy: number;
    uz: number;
    tan: number;
  };
}

export function strokeBytes(s: WireStroke): number {
  return BASE_BYTES + (s.kind === 'stamp' ? PATCH_BYTES : 0);
}

export function encodeStrokes(list: readonly WireStroke[]): Uint8Array {
  let total = 2;
  for (const s of list) total += strokeBytes(s);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(0, list.length, true);
  let o = 2;
  for (const s of list) {
    v.setUint8(o++, KINDS.indexOf(s.kind));
    v.setInt16(o, s.x, true);
    v.setInt16(o + 2, s.y, true);
    v.setInt16(o + 4, s.z, true);
    o += 6;
    v.setUint8(o++, Math.min(255, s.r));
    v.setUint8(o++, (s.rgb >> 16) & 255);
    v.setUint8(o++, (s.rgb >> 8) & 255);
    v.setUint8(o++, s.rgb & 255);
    v.setUint8(o++, s.rough);
    v.setUint8(o++, s.hard);
    v.setInt8(o++, s.nx);
    v.setInt8(o++, s.ny);
    v.setInt8(o++, s.nz);
    v.setUint16(o, s.seed & 0xffff, true);
    o += 2;
    if (s.kind === 'stamp' && s.patch) {
      const p = s.patch;
      v.setInt16(o, p.cx, true);
      v.setInt16(o + 2, p.cy, true);
      v.setInt16(o + 4, p.cz, true);
      o += 6;
      for (const n of [p.fx, p.fy, p.fz, p.ux, p.uy, p.uz]) v.setInt8(o++, n);
      v.setUint8(o++, p.tan);
      out.set(p.texels, o);
      o += p.texels.length;
    }
  }
  return out;
}

/** Decodes a batch; null when the bytes are not a well-formed stroke list. */
export function decodeStrokes(bytes: Uint8Array): WireStroke[] | null {
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_WIRE_BYTES + 64) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = v.getUint16(0, true);
  if (count > MAX_BATCH_STROKES) return null;
  const out: WireStroke[] = [];
  let o = 2;
  for (let i = 0; i < count; i++) {
    if (o + BASE_BYTES > bytes.byteLength) return null;
    const ki = v.getUint8(o++);
    if (ki >= KINDS.length) return null;
    const kind = KINDS[ki];
    const x = v.getInt16(o, true);
    const y = v.getInt16(o + 2, true);
    const z = v.getInt16(o + 4, true);
    o += 6;
    const r = v.getUint8(o++);
    const rgb = (v.getUint8(o) << 16) | (v.getUint8(o + 1) << 8) | v.getUint8(o + 2);
    o += 3;
    const rough = v.getUint8(o++);
    const hard = v.getUint8(o++);
    const nx = v.getInt8(o++);
    const ny = v.getInt8(o++);
    const nz = v.getInt8(o++);
    const seed = v.getUint16(o, true);
    o += 2;
    const stroke: WireStroke = { kind, x, y, z, r, rgb, rough, hard, nx, ny, nz, seed };
    if (kind === 'stamp') {
      if (o + PATCH_BYTES > bytes.byteLength) return null;
      const cx = v.getInt16(o, true);
      const cy = v.getInt16(o + 2, true);
      const cz = v.getInt16(o + 4, true);
      o += 6;
      const f = [v.getInt8(o), v.getInt8(o + 1), v.getInt8(o + 2), v.getInt8(o + 3), v.getInt8(o + 4), v.getInt8(o + 5)];
      const tan = v.getUint8(o + 6);
      o += 7;
      const size = STAMP_TEXELS * STAMP_TEXELS * 4;
      stroke.patch = { texels: bytes.slice(o, o + size), cx, cy, cz, fx: f[0], fy: f[1], fz: f[2], ux: f[3], uy: f[4], uz: f[5], tan };
      o += size;
    }
    out.push(stroke);
  }
  return o === bytes.byteLength ? out : null;
}

/** Body-space bounds a stroke may touch (millimetres): the shared hiding box plus the margin of a brush. */
const BOUNDS = { x: 900, yMin: -100, yMax: 1900, z: 900 };

export function strokeInBounds(s: WireStroke): boolean {
  if (s.kind === 'fill') return true;
  if (Math.abs(s.x) > BOUNDS.x || Math.abs(s.z) > BOUNDS.z || s.y < BOUNDS.yMin || s.y > BOUNDS.yMax) {
    return false;
  }
  return s.r >= 1;
}

export interface PaintBook {
  strokes: WireStroke[];
  bytes: number;
  stamps: number;
}

export function emptyPaintBook(): PaintBook {
  return { strokes: [], bytes: 2, stamps: 0 };
}

export interface PaintVerdict {
  accepted: WireStroke[];
  rejected: number;
}

/** Applies the per-player limits; whatever does not fit is dropped (the client sees it in the next snapshot). */
export function acceptStrokes(book: PaintBook, incoming: readonly WireStroke[]): PaintVerdict {
  const accepted: WireStroke[] = [];
  let rejected = 0;
  for (const s of incoming) {
    const cost = strokeBytes(s);
    if (
      !strokeInBounds(s) ||
      book.strokes.length >= MAX_STROKES_PER_PLAYER ||
      book.bytes + cost > MAX_WIRE_BYTES ||
      (s.kind === 'stamp' && (book.stamps >= MAX_STAMPS_PER_PLAYER || !s.patch))
    ) {
      rejected++;
      continue;
    }
    book.strokes.push(s);
    book.bytes += cost;
    if (s.kind === 'stamp') book.stamps++;
    accepted.push(s);
  }
  return { accepted, rejected };
}

/** Rough camouflage estimate for the bots: how close the painted colour is to the background (0..1). */
export function estimateCamo(book: PaintBook, background: number): number {
  if (!book.strokes.length) return 0;
  let w = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const s of book.strokes) {
    if (s.kind === 'stamp' && s.patch) {
      let sr = 0, sg = 0, sb = 0;
      const t = s.patch.texels;
      for (let i = 0; i < t.length; i += 4) { sr += t[i]; sg += t[i + 1]; sb += t[i + 2]; }
      const n = t.length / 4;
      const area = 40;
      w += area; r += (sr / n) * area; g += (sg / n) * area; b += (sb / n) * area;
    } else {
      const area = s.kind === 'fill' ? 300 : Math.max(1, (s.r / 10) ** 2);
      w += area;
      r += ((s.rgb >> 16) & 255) * area;
      g += ((s.rgb >> 8) & 255) * area;
      b += (s.rgb & 255) * area;
    }
  }
  if (!w) return 0;
  const dr = r / w - ((background >> 16) & 255);
  const dg = g / w - ((background >> 8) & 255);
  const db = b / w - (background & 255);
  const dist = Math.sqrt(dr * dr + dg * dg + db * db);
  const color = Math.max(0, 1 - dist / 140);
  const coverage = Math.min(1, w / 300);
  return Math.round(color * coverage * 100) / 100;
}
