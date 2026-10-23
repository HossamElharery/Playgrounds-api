/**
 * Room data of «استغماية»: collision boxes, hide spots, seats, spawns and forbidden zones, plus the walk grid the bots
 * and the eviction use. Pure: no Nest, no three.js. The locker room is generated here from a seed-free recipe so the
 * server and the client (which loads the same JSON) always agree.
 */

export type SurfaceMaterial = 'metal' | 'wood' | 'grass' | 'cloth' | 'tile' | 'concrete';

/** Bounce factor per material (section 5.2). */
export const RESTITUTION: Readonly<Record<SurfaceMaterial, number>> = Object.freeze({
  metal: 0.6,
  wood: 0.5,
  grass: 0.35,
  cloth: 0.15,
  tile: 0.45,
  concrete: 0.5,
});

export interface Aabb {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

export interface Collider extends Aabb {
  id: string;
  material: SurfaceMaterial;
}

export interface HideSpot {
  id: string;
  x: number;
  z: number;
  /** Where the surface faces (unit, on the floor plane). */
  nx: number;
  nz: number;
  surface: SurfaceMaterial;
  /** Poses that suit the spot. */
  poses: string[];
  /** 1 easy, 2 medium, 3 hard. */
  difficulty: 1 | 2 | 3;
  /** Colour (0xRRGGBB) of the background around the spot: what a bot paints itself with. */
  color: number;
  kind: 'locker' | 'bench' | 'wall' | 'corner' | 'floor' | 'shower' | 'prop';
  /**
   * What is really behind a body standing here, as six colours (0xRRGGBB) at 12, 40, 70, 100, 130 and 155 cm: baked from
   * the drawn room by `tools/camo/camo-bake-palettes.mjs`, so a bot paints itself with the true albedo of the wall.
   */
  bands?: number[];
}

export interface Seat {
  id: string;
  x: number;
  z: number;
  /** Seat top height. */
  y: number;
  nx: number;
  nz: number;
}

/** A decorative or solid object the client draws. */
export interface Prop {
  id: string;
  type: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  ry: number;
  material: SurfaceMaterial;
  /** Free text the client may print (locker numbers, signs). */
  label?: string;
}

export interface CamoRoomData {
  id: string;
  version: number;
  /** `roomShapeHash` of the room without baked colours; the palette bake stores it so a stale bake is caught. */
  shape?: string;
  /** Walkable rectangle (inside the walls). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  colliders: Collider[];
  hideSpots: HideSpot[];
  seats: Seat[];
  spawns: { hiders: Array<{ x: number; z: number }>; seekers: Array<{ x: number; z: number }> };
  /** The referees' waiting room: sealed during prep. */
  refereeRoom: Aabb & { door: { x: number; z: number } };
  /** Hiders may not settle here (referees' room + 5 m around its door). */
  forbidden: Aabb[];
  props: Prop[];
}

export const SURFACE_COLOR: Readonly<Record<SurfaceMaterial, number>> = Object.freeze({
  metal: 0x6f7f8f,
  wood: 0x7a5230,
  grass: 0x2f6b2f,
  cloth: 0x4e7a52,
  tile: 0x2f8f9a,
  concrete: 0x9a968c,
});

export const round = (n: number): number => Math.round(n * 1000) / 1000;

export const WALL_H = 4;
export const WALL_T = 0.4;

export const FNV = (text: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** Stable content hash of a room (the client refreshes its cache when it changes). */
export function roomHash(room: CamoRoomData): string {
  return FNV(JSON.stringify(room)).toString(16);
}

export function boxOf(cx: number, cz: number, w: number, d: number, h: number, y0 = 0): Aabb {
  return { minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, minY: y0, maxY: y0 + h };
}

export function insideAabb2d(x: number, z: number, b: Aabb, margin = 0): boolean {
  return x > b.minX - margin && x < b.maxX + margin && z > b.minZ - margin && z < b.maxZ + margin;
}

/** Whether a body of this radius standing at (x, z) is clear of every solid collider tall enough to block it. */
export function isWalkable(room: CamoRoomData, x: number, z: number, radius = 0.3): boolean {
  const b = room.bounds;
  if (x < b.minX + radius || x > b.maxX - radius || z < b.minZ + radius || z > b.maxZ - radius) return false;
  for (const c of room.colliders) {
    if (c.maxY < 0.45) continue; // low things can be stepped over
    if (x > c.minX - radius && x < c.maxX + radius && z > c.minZ - radius && z < c.maxZ + radius) return false;
  }
  return true;
}

/** Pushes a point out of whatever it overlaps (shallowest axis), then back inside the bounds. */
export function pushOut(room: CamoRoomData, x: number, z: number, radius = 0.3): { x: number; z: number } {
  let px = x;
  let pz = z;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const c of room.colliders) {
      if (c.maxY < 0.45) continue;
      if (!(px > c.minX - radius && px < c.maxX + radius && pz > c.minZ - radius && pz < c.maxZ + radius)) continue;
      const left = px - (c.minX - radius);
      const right = c.maxX + radius - px;
      const near = pz - (c.minZ - radius);
      const far = c.maxZ + radius - pz;
      const m = Math.min(left, right, near, far);
      if (m === left) px = c.minX - radius - 0.001;
      else if (m === right) px = c.maxX + radius + 0.001;
      else if (m === near) pz = c.minZ - radius - 0.001;
      else pz = c.maxZ + radius + 0.001;
      moved = true;
    }
    const b = room.bounds;
    px = Math.min(b.maxX - radius, Math.max(b.minX + radius, px));
    pz = Math.min(b.maxZ - radius, Math.max(b.minZ + radius, pz));
    if (!moved) break;
  }
  return { x: px, z: pz };
}

// ── walk grid + path finding (bots, eviction checks, reachability tests) ─────────────────────

export interface WalkGrid {
  cell: number;
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  blocked: Uint8Array;
}

export function buildWalkGrid(room: CamoRoomData, cell = 0.5, radius = 0.3): WalkGrid {
  const b = room.bounds;
  const cols = Math.ceil((b.maxX - b.minX) / cell);
  const rows = Math.ceil((b.maxZ - b.minZ) / cell);
  const blocked = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = b.minX + (c + 0.5) * cell;
      const z = b.minZ + (r + 0.5) * cell;
      if (!isWalkable(room, x, z, radius)) blocked[r * cols + c] = 1;
    }
  }
  return { cell, minX: b.minX, minZ: b.minZ, cols, rows, blocked };
}

const cellOf = (g: WalkGrid, x: number, z: number): [number, number] => [
  Math.min(g.cols - 1, Math.max(0, Math.floor((x - g.minX) / g.cell))),
  Math.min(g.rows - 1, Math.max(0, Math.floor((z - g.minZ) / g.cell))),
];

/** The closest free cell to a point (the point itself when free). */
function nearestFree(g: WalkGrid, x: number, z: number): [number, number] | null {
  const [c0, r0] = cellOf(g, x, z);
  if (!g.blocked[r0 * g.cols + c0]) return [c0, r0];
  for (let ring = 1; ring < 12; ring++) {
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const c = c0 + dc;
        const r = r0 + dr;
        if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
        if (!g.blocked[r * g.cols + c]) return [c, r];
      }
    }
  }
  return null;
}

/** A* over the 8-connected grid; returns world waypoints (cell centres) or null when unreachable. */
export function findPath(
  g: WalkGrid,
  from: { x: number; z: number },
  to: { x: number; z: number },
): Array<{ x: number; z: number }> | null {
  const a = nearestFree(g, from.x, from.z);
  const b = nearestFree(g, to.x, to.z);
  if (!a || !b) return null;
  const idx = (c: number, r: number): number => r * g.cols + c;
  const goal = idx(b[0], b[1]);
  const open: number[] = [idx(a[0], a[1])];
  const came = new Map<number, number>();
  const gScore = new Map<number, number>([[open[0], 0]]);
  const f = new Map<number, number>([[open[0], Math.hypot(a[0] - b[0], a[1] - b[1])]]);
  const closed = new Set<number>();
  while (open.length) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if ((f.get(open[i]) ?? Infinity) < (f.get(open[best]) ?? Infinity)) best = i;
    const cur = open.splice(best, 1)[0];
    if (cur === goal) {
      const path: Array<{ x: number; z: number }> = [];
      let n: number | undefined = cur;
      while (n !== undefined) {
        path.push({ x: g.minX + ((n % g.cols) + 0.5) * g.cell, z: g.minZ + (Math.floor(n / g.cols) + 0.5) * g.cell });
        n = came.get(n);
      }
      return path.reverse();
    }
    closed.add(cur);
    const cc = cur % g.cols;
    const cr = Math.floor(cur / g.cols);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dc && !dr) continue;
        const c = cc + dc;
        const r = cr + dr;
        if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
        const ni = idx(c, r);
        if (g.blocked[ni] || closed.has(ni)) continue;
        // no corner cutting
        if (dc && dr && (g.blocked[idx(cc + dc, cr)] || g.blocked[idx(cc, cr + dr)])) continue;
        const tentative = (gScore.get(cur) ?? 0) + (dc && dr ? 1.4142 : 1);
        if (tentative >= (gScore.get(ni) ?? Infinity)) continue;
        came.set(ni, cur);
        gScore.set(ni, tentative);
        f.set(ni, tentative + Math.hypot(c - b[0], r - b[1]));
        if (!open.includes(ni)) open.push(ni);
      }
    }
  }
  return null;
}

/** Whether a straight segment on the floor plane crosses a collider tall enough to block sight (eye height 1.2 m). */
const sightCache = new WeakMap<object, Collider[]>();

export function lineBlocked(room: CamoRoomData, ax: number, az: number, bx: number, bz: number, eye = 1.2): boolean {
  let list = sightCache.get(room.colliders);
  if (!list || eye !== 1.2) {
    list = room.colliders.filter((c) => c.maxY >= eye && c.minY <= eye);
    if (eye === 1.2) sightCache.set(room.colliders, list);
  }
  for (const c of list) {
    if (segmentHitsRect(ax, az, bx, bz, c.minX, c.minZ, c.maxX, c.maxZ)) return true;
  }
  return false;
}

function segmentHitsRect(ax: number, az: number, bx: number, bz: number, x0: number, z0: number, x1: number, z1: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dz, az - z0) && clip(dz, z1 - az);
}

/** Flood fill once from a point; the returned test says whether a point's nearest free cell can be walked to from there. */
export function reachableFrom(g: WalkGrid, from: { x: number; z: number }): (p: { x: number; z: number }) => boolean {
  const start = nearestFree(g, from.x, from.z);
  const seen = new Uint8Array(g.cols * g.rows);
  if (start) {
    const stack: number[] = [start[1] * g.cols + start[0]];
    seen[stack[0]] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      const cc = cur % g.cols;
      const cr = Math.floor(cur / g.cols);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const c = cc + dc;
          const r = cr + dr;
          if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
          const ni = r * g.cols + c;
          if (g.blocked[ni] || seen[ni]) continue;
          if (dc && dr && (g.blocked[cr * g.cols + (cc + dc)] || g.blocked[(cr + dr) * g.cols + cc])) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }
  }
  return (p) => {
    const cell = nearestFree(g, p.x, p.z);
    return !!cell && seen[cell[1] * g.cols + cell[0]] === 1;
  };
}

/** Hash of everything that decides where a hide spot is: the room without the baked colours (the bake checks it is current). */
export function roomShapeHash(room: CamoRoomData): string {
  const { shape, ...body } = room;
  void shape;
  return FNV(JSON.stringify({ ...body, hideSpots: room.hideSpots.map(({ bands, ...rest }) => (void bands, rest)) })).toString(16);
}
