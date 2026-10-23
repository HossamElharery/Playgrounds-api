/**
 * What a hider can become and how big that body is when a ball or a lunge meets it. Pure, mirrored on the client: both sides
 * must agree on which props are copyable, because the hider's choice travels as an index into `room.props`.
 */
import { DISGUISE } from './camo-constants';
import type { CamoRoomData, Prop } from './camo-room';

/** Structure, decoration and signage: never copied. */
const NEVER = new Set([
  'walls',
  'ref-room',
  'pillar',
  'column',
  'beam',
  'skywindow',
  'hang-lamp',
  'flicker-lamp',
  'lane',
  'tunnel',
  'shower-wall',
  'shower-back',
  'locker',
  'poster-a',
  'poster-b',
  'poster-c',
  'poster-d',
  'poster-book',
  'booking-banner',
  'booking-board',
  'booking-poster',
  'old-photo',
  'tactics-board',
  'board',
  'clock',
  'tv',
  'jersey',
  'bunting',
  'lantern-string',
  'curtain',
  'door',
  'balcony',
  'fence',
  'fence-post',
  'goal-net',
  'floodlight',
  'container',
  'office',
  'shelf-rack',
  'forklift',
  'parked-car',
  'dugout',
  'kiosk',
  'stall',
]);

export interface DisguiseBody {
  /** Collision/hit radius (m) and height (m) of the disguised body. */
  r: number;
  h: number;
}

/** Whether this prop may be copied, and the body the copy has. */
export function disguiseBody(p: Prop | undefined): DisguiseBody | null {
  if (!p || NEVER.has(p.type)) return null;
  // hanging or wall-mounted things (lanterns, signs) are not something to stand on the floor as
  if (p.y - p.h / 2 > 0.35) return null;
  const foot = Math.max(p.w, p.d);
  const hi = p.type === 'cone' || p.type === 'shoes' || p.type === 'towel' || p.type === 'bag' ? Math.max(p.h, DISGUISE.minHeight) : p.h;
  if (hi < DISGUISE.minHeight || hi > DISGUISE.maxHeight || foot > DISGUISE.maxFootprint || Math.min(p.w, p.d) < 0.08) return null;
  const clamp = (v: number, lo: number, hi2: number): number => Math.min(hi2, Math.max(lo, v));
  return { r: clamp(foot / 2 + 0.06, DISGUISE.hitRadius.min, DISGUISE.hitRadius.max), h: clamp(hi + 0.08, DISGUISE.hitHeight.min, DISGUISE.hitHeight.max) };
}

/** Distance from a point to the footprint box of a prop (0 inside). */
export function distToProp(p: Prop, x: number, z: number): number {
  const hw = p.w / 2 + 0.05;
  const hd = p.d / 2 + 0.05;
  const c = Math.cos(p.ry);
  const s = Math.sin(p.ry);
  const lx = (x - p.x) * c - (z - p.z) * s;
  const lz = (x - p.x) * s + (z - p.z) * c;
  const dx = Math.max(0, Math.abs(lx) - hw);
  const dz = Math.max(0, Math.abs(lz) - hd);
  return Math.hypot(dx, dz);
}

/** The props a hider standing here can copy, nearest first: [index in room.props, distance]. */
export function copyable(room: Pick<CamoRoomData, 'props'>, x: number, z: number, reach: number = DISGUISE.reachM): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  room.props.forEach((p, i) => {
    if (!disguiseBody(p)) return;
    const d = distToProp(p, x, z);
    if (d <= reach) out.push([i, d]);
  });
  return out.sort((a, b) => a[1] - b[1]);
}
