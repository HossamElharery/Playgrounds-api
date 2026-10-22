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

const WALL_H = 4;
const WALL_T = 0.4;
let uid = 0;

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

// ── generator ────────────────────────────────────────────────────────────────

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** The locker room (`locker_room`): 36 x 26 m, lockers on three walls, benches, showers, the referees' room. */
export function generateLockerRoom(): CamoRoomData {
  uid = 0;
  const minX = -18;
  const maxX = 18;
  const minZ = -13;
  const maxZ = 13;
  const colliders: Collider[] = [];
  const props: Prop[] = [];
  const spots: HideSpot[] = [];
  const seats: Seat[] = [];
  const id = (p: string): string => `${p}${++uid}`;

  const solid = (cid: string, a: Aabb, material: SurfaceMaterial): void => {
    colliders.push({ id: cid, ...a, material });
  };
  const prop = (type: string, cx: number, cz: number, w: number, h: number, d: number, material: SurfaceMaterial, ry = 0, label?: string, y = h / 2): void => {
    props.push({ id: id(type), type, x: round(cx), y: round(y), z: round(cz), w, h, d, ry, material, ...(label ? { label } : {}) });
  };

  // Walls (outside the bounds so the walkable rectangle is the room).
  solid('wall-n', { minX: minX - WALL_T, maxX: maxX + WALL_T, minZ: minZ - WALL_T, maxZ: minZ, minY: 0, maxY: WALL_H }, 'concrete');
  solid('wall-s', { minX: minX - WALL_T, maxX: maxX + WALL_T, minZ: maxZ, maxZ: maxZ + WALL_T, minY: 0, maxY: WALL_H }, 'concrete');
  solid('wall-w', { minX: minX - WALL_T, maxX: minX, minZ, maxZ, minY: 0, maxY: WALL_H }, 'concrete');
  solid('wall-e', { minX: maxX, maxX: maxX + WALL_T, minZ, maxZ, minY: 0, maxY: WALL_H }, 'concrete');
  prop('walls', 0, 0, maxX - minX, WALL_H, maxZ - minZ, 'concrete');

  // Locker banks: north wall (2 banks), west wall, east wall. Locker 0.6 x 2.0 x 0.5.
  const lockerW = 0.6;
  const lockerD = 0.5;
  const lockerH = 2.0;
  let lockerNo = 1;
  const bank = (cid: string, x0: number, z0: number, dir: 'x' | 'z', count: number, facing: { x: number; z: number }): void => {
    const first = lockerNo;
    for (let i = 0; i < count; i++) {
      const cx = dir === 'x' ? x0 + i * lockerW + lockerW / 2 : x0;
      const cz = dir === 'z' ? z0 + i * lockerW + lockerW / 2 : z0;
      const w = dir === 'x' ? lockerW : lockerD;
      const d = dir === 'x' ? lockerD : lockerW;
      solid(`${cid}-${i}`, boxOf(cx, cz, w, d, lockerH), 'metal');
      prop('locker', cx, cz, w, lockerH, d, 'metal', Math.atan2(facing.x, facing.z), String(lockerNo));
      lockerNo++;
    }
    void first;
  };
  bank('lk-n1', -15.6, minZ + lockerD / 2, 'x', 14, { x: 0, z: 1 });
  bank('lk-n2', 4.2, minZ + lockerD / 2, 'x', 14, { x: 0, z: 1 });
  bank('lk-w', minX + lockerD / 2, -9, 'z', 12, { x: 1, z: 0 });
  bank('lk-e', maxX - lockerD / 2, -9, 'z', 12, { x: -1, z: 0 });

  // Benches in front of the locker banks (sit spots) and rows in the middle.
  const benchH = 0.45;
  const bench = (cx: number, cz: number, w: number, d: number, rot: 0 | 1): void => {
    const bw = rot ? d : w;
    const bd = rot ? w : d;
    solid(id('bench'), boxOf(cx, cz, bw, bd, benchH), 'wood');
    prop('bench', cx, cz, bw, benchH, bd, 'wood');
    seats.push({ id: id('seat'), x: round(cx), z: round(cz), y: benchH, nx: 0, nz: 1 });
  };
  for (const x of [-12, -6, 0, 6, 12]) bench(x, -9, 2.6, 0.5, 0);
  for (const z of [-5, -1, 3]) {
    bench(-15, z, 2.6, 0.5, 1);
    bench(15, z, 2.6, 0.5, 1);
  }
  for (const [cx, cz] of [[-9, 2], [-9, 5.5], [9, 2], [9, 5.5], [0, 6.5]] as const) bench(cx, cz, 3.0, 0.5, 0);

  // Tactics table and board, ice tub, ball nets, crates, cones: solid scenery spread through the middle.
  solid('tactics-table', boxOf(0, -1, 2.6, 1.2, 0.9), 'wood');
  prop('tactics-table', 0, -1, 2.6, 0.9, 1.2, 'wood');
  solid('tactics-board', boxOf(0, -4.2, 2.4, 0.15, 1.8), 'metal');
  prop('tactics-board', 0, -4.2, 2.4, 1.8, 0.15, 'metal');
  solid('ice-tub', boxOf(-8, 11.5, 1.8, 0.9, 0.9), 'metal');
  prop('ice-tub', -8, 11.5, 1.8, 0.9, 0.9, 'metal');
  solid('ball-net-1', boxOf(13.5, 10, 1.0, 1.0, 1.1), 'cloth');
  prop('ball-net', 13.5, 10, 1.0, 1.1, 1.0, 'cloth');
  solid('ball-net-2', boxOf(15, 7.8, 1.0, 1.0, 1.1), 'cloth');
  prop('ball-net', 15, 7.8, 1.0, 1.1, 1.0, 'cloth');
  for (const [cx, cz] of [[-5, 10], [-3, 10.8], [3, 10], [5, 10.8], [8, 9]] as const) {
    solid(id('crate'), boxOf(cx, cz, 0.7, 0.5, 0.5), 'wood');
    prop('water-crate', cx, cz, 0.7, 0.5, 0.5, 'wood');
  }
  for (let i = 0; i < 8; i++) {
    const cx = -7 + i * 0.9;
    solid(id('cone'), boxOf(cx, 11.2, 0.3, 0.3, 0.4), 'cloth');
    prop('cone', cx, 11.2, 0.3, 0.4, 0.3, 'cloth');
  }

  // Showers (south-east): tiled stalls with thin partitions.
  for (let i = 0; i < 5; i++) {
    const cx = 9.5 + i * 1.6;
    solid(id('shower-wall'), boxOf(cx + 0.8, 10.5, 0.1, 2.4, 2.0), 'tile');
    prop('shower-wall', cx + 0.8, 10.5, 0.1, 2.0, 2.4, 'tile');
  }
  solid('shower-back', boxOf(13.3, 12.2, 8.2, 0.2, 2.4), 'tile');
  prop('shower-back', 13.3, 12.2, 8.2, 2.4, 0.2, 'tile');

  // Referees' room (south-west): 5 x 4, door facing north-east into the hall.
  const rr: CamoRoomData['refereeRoom'] = { ...boxOf(-15.3, 10.5, 5, 4, WALL_H), door: { x: -13.8, z: 8.5 } };
  solid('ref-n', { minX: rr.minX, maxX: -14.4, minZ: rr.minZ, maxZ: rr.minZ + 0.2, minY: 0, maxY: 2.6 }, 'wood');
  solid('ref-n2', { minX: -13.2, maxX: rr.maxX, minZ: rr.minZ, maxZ: rr.minZ + 0.2, minY: 0, maxY: 2.6 }, 'wood');
  solid('ref-e', { minX: rr.maxX - 0.2, maxX: rr.maxX, minZ: rr.minZ, maxZ: rr.maxZ, minY: 0, maxY: 2.6 }, 'wood');
  prop('ref-room', -15.3, 10.5, 5, 2.6, 4, 'wood');
  const forbidden: Aabb[] = [
    { minX: rr.minX, maxX: rr.maxX, minZ: rr.minZ, maxZ: rr.maxZ, minY: 0, maxY: WALL_H },
    { minX: rr.door.x - 5, maxX: rr.door.x + 5, minZ: rr.door.z - 5, maxZ: rr.door.z + 5, minY: 0, maxY: WALL_H },
  ];

  // Decor that does not block: posters, jerseys, the tunnel to the pitch.
  prop('poster-book', -9, minZ + 0.05, 3.2, 2.2, 0.05, 'concrete', 0, 'احجز ملعبك على ماتشينا', 2.0);
  prop('tunnel', maxX - 0.05, 2, 0.1, 3, 4, 'concrete', Math.PI / 2, 'النفق', 1.5);
  for (let i = 0; i < 10; i++) prop('jersey', -13 + i * 2.7, minZ + 1.1, 0.5, 0.7, 0.05, 'cloth', 0, String((i % 11) + 1), 1.9);
  prop('flicker-lamp', -16, -11, 0.4, 0.1, 0.4, 'metal', 0, 'flicker', 3.9);

  // ── hide spots (≥ 50): every second locker front, bench sits, wall gaps, corners, showers, props ──
  let n = 0;
  const spot = (x: number, z: number, nx: number, nz: number, surface: SurfaceMaterial, poses: string[], difficulty: 1 | 2 | 3, kind: HideSpot['kind']): void => {
    spots.push({ id: `hs${++n}`, x: round(x), z: round(z), nx, nz, surface, poses, difficulty, kind, color: SURFACE_COLOR[surface] });
  };
  for (const c of colliders) {
    if (c.id.startsWith('lk-n') && Number(c.id.split('-')[2]) % 2 === 0)
      spot((c.minX + c.maxX) / 2, c.maxZ + 0.42, 0, 1, 'metal', ['stand', 'wall', 'lean_l', 'lean_r'], 2, 'locker');
    else if (c.id.startsWith('lk-w') && Number(c.id.split('-')[2]) % 2 === 0)
      spot(c.maxX + 0.42, (c.minZ + c.maxZ) / 2, 1, 0, 'metal', ['stand', 'wall', 'lean_l'], 2, 'locker');
    else if (c.id.startsWith('lk-e') && Number(c.id.split('-')[2]) % 2 === 0)
      spot(c.minX - 0.42, (c.minZ + c.maxZ) / 2, -1, 0, 'metal', ['stand', 'wall', 'lean_r'], 2, 'locker');
  }
  for (const s of seats) spot(s.x + 0.4, s.z + 0.55, 0, 1, 'wood', ['sit', 'crouch', 'ball'], 1, 'bench');
  spot(minX + 0.5, minZ + 1.6, 1, 1, 'concrete', ['crouch', 'ball', 'flat'], 3, 'corner');
  spot(maxX - 0.5, minZ + 1.6, -1, 1, 'concrete', ['crouch', 'ball', 'flat'], 3, 'corner');
  spot(minX + 0.5, 0, 1, 0, 'concrete', ['wall', 'stand', 'lean_l'], 2, 'wall');
  spot(maxX - 0.5, 0, -1, 0, 'concrete', ['wall', 'stand', 'lean_r'], 2, 'wall');
  spot(minX + 0.5, 4, 1, 0, 'concrete', ['wall', 'stand'], 2, 'wall');
  spot(maxX - 0.5, 5, -1, 0, 'concrete', ['wall', 'stand'], 2, 'wall');
  spot(0, maxZ - 0.5, 0, -1, 'concrete', ['wall', 'stand', 'bend'], 2, 'wall');
  spot(-6, maxZ - 0.5, 0, -1, 'concrete', ['wall', 'stand'], 2, 'wall');
  spot(6, maxZ - 0.5, 0, -1, 'concrete', ['wall', 'stand'], 2, 'wall');
  spot(-1.8, -1, -1, 0, 'wood', ['crouch', 'bend', 'ball'], 2, 'prop');
  spot(1.8, -1, 1, 0, 'wood', ['crouch', 'bend', 'ball'], 2, 'prop');
  spot(0, 0.2, 0, 1, 'wood', ['crouch', 'flat'], 3, 'prop');
  spot(-8, 10.5, 0, -1, 'metal', ['crouch', 'ball'], 3, 'prop');
  spot(-6.7, 11.5, 1, 0, 'metal', ['stand', 'lean_l'], 2, 'prop');
  spot(13.5, 8.9, 0, -1, 'cloth', ['ball', 'crouch'], 3, 'prop');
  for (let i = 0; i < 5; i++) {
    spot(9.5 + i * 1.6 + 0.4, 10.5, 1, 0, 'tile', ['wall', 'stand', 'crouch'], 3, 'shower');
    spot(9.5 + i * 1.6 + 0.4, 11.9, 0, -1, 'tile', ['wall', 'stand'], 2, 'shower');
  }

  const hiders: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < 10; i++) hiders.push({ x: round(-4.5 + i * 1.0), z: 4.2 });
  const seekers: Array<{ x: number; z: number }> = [
    { x: -16.2, z: 11.2 },
    { x: -15.2, z: 11.2 },
    { x: -14.2, z: 11.2 },
  ];

  const draft: CamoRoomData = {
    id: 'locker_room',
    version: 1,
    bounds: { minX, maxX, minZ, maxZ },
    colliders,
    hideSpots: [],
    seats,
    spawns: { hiders, seekers },
    refereeRoom: rr,
    forbidden,
    props,
  };
  // Candidates are nudged onto free floor and dropped when they sit in a forbidden zone or cannot be reached.
  const grid = buildWalkGrid(draft);
  const kept: HideSpot[] = [];
  for (const c of spots) {
    const p = pushOut(draft, c.x, c.z);
    if (forbidden.some((f) => insideAabb2d(p.x, p.z, f))) continue;
    if (!findPath(grid, hiders[0], p) || !findPath(grid, seekers[0], p)) continue;
    kept.push({ ...c, id: `hs${kept.length + 1}`, x: round(p.x), z: round(p.z) });
  }
  draft.hideSpots = kept;
  return draft;
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
