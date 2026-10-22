import {
  SURFACE_COLOR,
  WALL_H,
  WALL_T,
  boxOf,
  buildWalkGrid,
  findPath,
  insideAabb2d,
  pushOut,
  round,
  type Aabb,
  type CamoRoomData,
  type Collider,
  type HideSpot,
  type Prop,
  type Seat,
  type SurfaceMaterial,
} from './camo-room';

/**
 * The three M2 rooms (section 9), generated from recipes like the locker room so the server and the client agree.
 * Each has 40+ hide spots, a referees' room with a door, seats and walk-grid reachability checks.
 */
interface Builder {
  colliders: Collider[];
  props: Prop[];
  spots: HideSpot[];
  seats: Seat[];
  solid(cid: string, a: Aabb, m: SurfaceMaterial): void;
  prop(type: string, cx: number, cz: number, w: number, h: number, d: number, m: SurfaceMaterial, ry?: number, label?: string, y?: number): void;
  item(type: string, cx: number, cz: number, w: number, d: number, h: number, m: SurfaceMaterial, opts?: { label?: string; ry?: number; solid?: boolean; y?: number }): void;
  spot(x: number, z: number, nx: number, nz: number, surface: SurfaceMaterial, poses: string[], difficulty: 1 | 2 | 3, kind: HideSpot['kind'], color?: number): void;
  seat(x: number, z: number, y: number): void;
}

function builder(): Builder {
  let uid = 0;
  const b: Builder = {
    colliders: [],
    props: [],
    spots: [],
    seats: [],
    solid: (cid, a, m) => void b.colliders.push({ id: cid, ...a, material: m }),
    prop: (type, cx, cz, w, h, d, m, ry = 0, label, y = h / 2) => void b.props.push({ id: `${type}${++uid}`, type, x: round(cx), y: round(y), z: round(cz), w, h, d, ry, material: m, ...(label ? { label } : {}) }),
    item: (type, cx, cz, w, d, h, m, o = {}) => {
      if (o.solid !== false) b.solid(`${type}${++uid}`, boxOf(cx, cz, w, d, h), m);
      b.prop(type, cx, cz, w, h, d, m, o.ry ?? 0, o.label, o.y);
    },
    spot: (x, z, nx, nz, surface, poses, difficulty, kind, color) => void b.spots.push({ id: `hs${b.spots.length + 1}`, x: round(x), z: round(z), nx, nz, surface, poses, difficulty, kind, color: color ?? SURFACE_COLOR[surface] }),
    seat: (x, z, y) => void b.seats.push({ id: `seat${b.seats.length + 1}`, x: round(x), z: round(z), y, nx: 0, nz: 1 }),
  };
  return b;
}

function walls(b: Builder, minX: number, maxX: number, minZ: number, maxZ: number): void {
  b.solid('wall-n', { minX: minX - WALL_T, maxX: maxX + WALL_T, minZ: minZ - WALL_T, maxZ: minZ, minY: 0, maxY: WALL_H }, 'concrete');
  b.solid('wall-s', { minX: minX - WALL_T, maxX: maxX + WALL_T, minZ: maxZ, maxZ: maxZ + WALL_T, minY: 0, maxY: WALL_H }, 'concrete');
  b.solid('wall-w', { minX: minX - WALL_T, maxX: minX, minZ, maxZ, minY: 0, maxY: WALL_H }, 'concrete');
  b.solid('wall-e', { minX: maxX, maxX: maxX + WALL_T, minZ, maxZ, minY: 0, maxY: WALL_H }, 'concrete');
  b.prop('walls', 0, 0, maxX - minX, WALL_H, maxZ - minZ, 'concrete');
}

/** The referees' room in the south-west corner: a 5 x 4 box with a door facing the room. */
function refereeRoom(b: Builder, minX: number, maxZ: number): CamoRoomData['refereeRoom'] {
  const x0 = minX + 0.2;
  const z0 = maxZ - 4.2;
  const rr: CamoRoomData['refereeRoom'] = { minX: x0, maxX: x0 + 5, minZ: z0, maxZ: z0 + 4, minY: 0, maxY: WALL_H, door: { x: x0 + 1.5, z: z0 } };
  b.solid('ref-n', { minX: rr.minX, maxX: rr.door.x - 0.6, minZ: rr.minZ, maxZ: rr.minZ + 0.2, minY: 0, maxY: 2.6 }, 'wood');
  b.solid('ref-n2', { minX: rr.door.x + 0.6, maxX: rr.maxX, minZ: rr.minZ, maxZ: rr.minZ + 0.2, minY: 0, maxY: 2.6 }, 'wood');
  b.solid('ref-e', { minX: rr.maxX - 0.2, maxX: rr.maxX, minZ: rr.minZ, maxZ: rr.maxZ, minY: 0, maxY: 2.6 }, 'wood');
  b.prop('ref-room', (rr.minX + rr.maxX) / 2, (rr.minZ + rr.maxZ) / 2, 5, 2.6, 4, 'wood');
  return rr;
}

function finish(id: string, b: Builder, bounds: CamoRoomData['bounds'], rr: CamoRoomData['refereeRoom'], hiders: Array<{ x: number; z: number }>): CamoRoomData {
  const forbidden: Aabb[] = [
    { minX: rr.minX, maxX: rr.maxX, minZ: rr.minZ, maxZ: rr.maxZ, minY: 0, maxY: WALL_H },
    { minX: rr.door.x - 5, maxX: rr.door.x + 5, minZ: rr.door.z - 5, maxZ: rr.door.z + 5, minY: 0, maxY: WALL_H },
  ];
  const seekers = [0, 1, 2].map((i) => ({ x: round(rr.minX + 1 + i), z: round(rr.maxZ - 1) }));
  const draft: CamoRoomData = { id, version: 1, bounds, colliders: b.colliders, hideSpots: [], seats: b.seats, spawns: { hiders, seekers }, refereeRoom: rr, forbidden, props: b.props };
  const grid = buildWalkGrid(draft);
  const kept: HideSpot[] = [];
  for (const c of b.spots) {
    const p = pushOut(draft, c.x, c.z);
    if (forbidden.some((f) => insideAabb2d(p.x, p.z, f))) continue;
    if (!findPath(grid, hiders[0], p) || !findPath(grid, seekers[0], p)) continue;
    kept.push({ ...c, id: `hs${kept.length + 1}`, x: round(p.x), z: round(p.z) });
  }
  draft.hideSpots = kept;
  return draft;
}

const ring = (n: number, r: number, cx: number, cz: number, fn: (x: number, z: number, a: number, i: number) => void): void => {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    fn(cx + Math.cos(a) * r, cz + Math.sin(a) * r, a, i);
  }
};

/** Five-a-side at night: artificial grass, fence, goals, subs bench, snack kiosk, plastic chairs, a parked car. */
export function generateFiveASide(): CamoRoomData {
  const minX = -22, maxX = 22, minZ = -15, maxZ = 15;
  const b = builder();
  walls(b, minX, maxX, minZ, maxZ);
  const rr = refereeRoom(b, minX, maxZ);
  // goals at both ends
  for (const sx of [-1, 1]) {
    b.item('goal', sx * 19.5, 0, 0.3, 7, 2.4, 'metal');
    b.item('goal-net', sx * 20.5, 0, 1.5, 7, 2.4, 'cloth', { solid: false });
    b.spot(sx * 18.8, 2.5, -sx, 0, 'metal', ['stand', 'wall', 'lean_l'], 2, 'prop');
    b.spot(sx * 18.8, -2.5, -sx, 0, 'metal', ['stand', 'wall', 'lean_r'], 2, 'prop');
    b.spot(sx * 20.6, 0, -sx, 0, 'cloth', ['crouch', 'ball', 'flat'], 3, 'prop');
  }
  // fence posts along the long sides (hide behind the mesh)
  for (let i = 0; i < 14; i++) {
    const x = -19.5 + i * 3;
    b.item('fence-post', x, minZ + 1.2, 0.2, 0.2, 2.6, 'metal');
    b.item('fence-post', x, maxZ - 1.2, 0.2, 0.2, 2.6, 'metal');
    if (i % 2 === 0) {
      b.spot(x, minZ + 1.9, 0, 1, 'metal', ['stand', 'wall', 'lean_l'], 2, 'wall');
      b.spot(x + 1.5, maxZ - 1.9, 0, -1, 'metal', ['stand', 'wall', 'lean_r'], 2, 'wall');
    }
  }
  // subs bench, snack kiosk, plastic chairs, cooler boxes, cones, a parked car outside the fence corner
  b.item('subs-bench', -8, minZ + 2.4, 5, 0.6, 0.5, 'wood');
  for (let i = 0; i < 5; i++) b.seat(-10 + i, minZ + 2.4, 0.5);
  b.spot(-8, minZ + 3.3, 0, 1, 'wood', ['sit', 'crouch', 'ball'], 1, 'bench');
  b.spot(-11, minZ + 3.3, 0, 1, 'wood', ['sit', 'crouch'], 1, 'bench');
  b.item('kiosk', 12, maxZ - 3, 4.5, 2.4, 2.6, 'wood', { label: 'شيبسي وبيبسي' });
  b.item('chips-stack', 9.2, maxZ - 2.2, 0.8, 0.8, 1.2, 'cloth', { label: 'شيبسي' });
  b.spot(12, maxZ - 5, 0, -1, 'wood', ['wall', 'stand', 'lean_l'], 2, 'prop');
  b.spot(9.6, maxZ - 4.2, 1, 0, 'cloth', ['crouch', 'ball'], 3, 'prop');
  for (let i = 0; i < 6; i++) {
    const cx = 5 + (i % 3) * 1.2, cz = maxZ - 6 - Math.floor(i / 3) * 1.2;
    b.item('plastic-chair', cx, cz, 0.5, 0.5, 0.45, 'cloth', { ry: i });
    b.seat(cx, cz, 0.45);
  }
  b.spot(5, maxZ - 7.5, 0, -1, 'cloth', ['sit', 'crouch'], 1, 'bench');
  b.spot(7.4, maxZ - 7.5, 0, -1, 'cloth', ['sit', 'crouch', 'ball'], 1, 'bench');
  b.item('booking-board', maxX - 0.3, -6, 0.2, 4, 2.2, 'metal', { label: 'احجز ملعبك على ماتشينا', solid: false, y: 1.6 });
  b.item('parked-car', maxX - 3, minZ + 2.5, 4.2, 1.8, 1.4, 'metal');
  b.spot(maxX - 3, minZ + 4, 0, 1, 'metal', ['wall', 'stand', 'lean_r'], 2, 'prop');
  for (let i = 0; i < 6; i++) {
    b.item('cone', -6 + i * 2.4, 8, 0.3, 0.3, 0.4, 'cloth');
    if (i % 2 === 0) b.spot(-6 + i * 2.4, 8.7, 0, 1, 'cloth', ['crouch', 'ball'], 3, 'prop');
  }
  b.item('floodlight', -12, minZ + 0.6, 0.5, 0.5, 4.5, 'metal');
  b.item('floodlight', 12, maxZ - 0.6, 0.5, 0.5, 4.5, 'metal');
  b.spot(-12, minZ + 1.4, 0, 1, 'metal', ['wall', 'stand'], 2, 'prop');
  b.spot(12, maxZ - 1.4, 0, -1, 'metal', ['wall', 'stand'], 2, 'prop');
  // centre circle line props and corners / walls
  b.spot(minX + 0.5, minZ + 1, 1, 1, 'grass', ['crouch', 'ball', 'flat'], 3, 'corner');
  b.spot(maxX - 0.5, minZ + 1, -1, 1, 'grass', ['crouch', 'ball', 'flat'], 3, 'corner');
  b.spot(maxX - 0.5, maxZ - 1, -1, -1, 'grass', ['crouch', 'ball', 'flat'], 3, 'corner');
  for (const z of [-9, -4, 4, 9]) {
    b.spot(minX + 0.5, z, 1, 0, 'concrete', ['wall', 'stand', 'lean_l'], 2, 'wall');
    b.spot(maxX - 0.5, z, -1, 0, 'concrete', ['wall', 'stand', 'lean_r'], 2, 'wall');
  }
  for (const x of [-14, -4, 4, 14]) b.spot(x, 0, 0, 1, 'grass', ['flat', 'crouch'], 3, 'floor');
  const hiders = Array.from({ length: 10 }, (_, i) => ({ x: round(-5 + i), z: 0.5 }));
  return finish('five_a_side', b, { minX, maxX, minZ, maxZ }, rr, hiders);
}

/** The traditional ahwa during a match: wicker chairs, marble tables, shisha, TV, backgammon, curtain. */
export function generateAhwa(): CamoRoomData {
  const minX = -16, maxX = 16, minZ = -12, maxZ = 12;
  const b = builder();
  walls(b, minX, maxX, minZ, maxZ);
  const rr = refereeRoom(b, minX, maxZ);
  // marble tables with 4 wicker chairs each
  const tables: Array<[number, number]> = [[-8, -6], [0, -6], [8, -6], [-8, 0], [0, 0], [8, 0], [-4, 6], [4, 6], [12, 6]];
  tables.forEach(([tx, tz], i) => {
    b.item('marble-table', tx, tz, 0.9, 0.9, 0.75, 'tile');
    if (i % 2 === 0) b.item('shisha', tx + 0.1, tz, 0.3, 0.3, 1.0, 'metal', { solid: false, y: 1.25 });
    for (const [dx, dz] of [[-0.9, 0], [0.9, 0], [0, -0.9], [0, 0.9]] as const) {
      b.item('wicker-chair', tx + dx, tz + dz, 0.5, 0.5, 0.9, 'wood', { ry: Math.atan2(dx, dz) });
      b.seat(tx + dx, tz + dz, 0.45);
    }
    b.spot(tx, tz + 1.8, 0, 1, 'tile', ['crouch', 'bend', 'ball'], 2, 'prop');
    b.spot(tx - 1.8, tz, 1, 0, 'wood', ['sit', 'crouch'], 1, 'bench');
  });
  // the TV wall with a live match, old tiles and the national-team photo, the tea corner, the curtain
  b.item('tv', 0, minZ + 0.3, 3.2, 0.2, 1.8, 'concrete', { label: 'tv-match', solid: false, y: 2.2 });
  b.item('old-photo', -10, minZ + 0.1, 1.6, 0.1, 1.1, 'concrete', { label: 'المنتخب 1990', solid: false, y: 2.0 });
  b.item('tea-counter', 12, minZ + 1.2, 5, 1.2, 1.1, 'wood', { label: 'واحد شاي!' });
  b.item('tea-kettles', 11, minZ + 1.2, 0.5, 0.5, 0.5, 'metal', { solid: false, y: 1.4 });
  b.item('curtain', maxX - 0.4, 2, 0.15, 5, 2.8, 'cloth');
  b.item('tawla-table', -13, 4, 1.4, 1.0, 0.75, 'wood', { label: 'طاولة' });
  b.item('domino-table', -13, 7, 1.4, 1.0, 0.75, 'wood', { label: 'دومينو' });
  b.item('booking-poster', maxX - 0.1, -4, 0.1, 2.0, 2.6, 'concrete', { label: 'احجز ملعبك على ماتشينا', solid: false, y: 1.8 });
  b.spot(0, minZ + 1.2, 0, 1, 'concrete', ['wall', 'stand', 'lean_l'], 2, 'wall');
  b.spot(-10, minZ + 1.0, 0, 1, 'concrete', ['wall', 'stand'], 2, 'wall');
  b.spot(12, minZ + 2.6, 0, 1, 'wood', ['wall', 'stand', 'lean_r'], 2, 'prop');
  b.spot(maxX - 1.2, 2, -1, 0, 'cloth', ['wall', 'stand', 'bend', 'lean_l'], 3, 'wall');
  b.spot(maxX - 1.2, 4.8, -1, 0, 'cloth', ['wall', 'stand'], 3, 'wall');
  b.spot(-13, 5.5, 1, 0, 'wood', ['crouch', 'bend', 'ball'], 2, 'prop');
  b.spot(-13, 8.4, 1, 0, 'wood', ['crouch', 'bend'], 2, 'prop');
  for (const z of [-8, -3, 3, 8]) b.spot(minX + 0.5, z, 1, 0, 'tile', ['wall', 'stand', 'lean_l'], 2, 'wall');
  for (const x of [-12, -6, 0, 6, 12]) b.spot(x, maxZ - 0.5, 0, -1, 'tile', ['wall', 'stand', 'lean_r'], 2, 'wall');
  for (const [tx, tz] of tables.slice(0, 6)) b.spot(tx + 2.6, tz + 1.4, 0, -1, 'wood', ['sit', 'crouch', 'ball'], 1, 'bench');
  for (const x of [-6, 2, 10]) b.spot(x, minZ + 1.3, 0, 1, 'tile', ['wall', 'stand', 'bend'], 2, 'wall');
  b.spot(minX + 0.5, minZ + 0.8, 1, 1, 'tile', ['crouch', 'ball', 'flat'], 3, 'corner');
  b.spot(maxX - 0.5, maxZ - 0.8, -1, -1, 'tile', ['crouch', 'ball', 'flat'], 3, 'corner');
  b.spot(maxX - 0.5, minZ + 0.8, -1, 1, 'tile', ['crouch', 'ball', 'flat'], 3, 'corner');
  const hiders = Array.from({ length: 10 }, (_, i) => ({ x: round(-4.5 + i), z: 3 }));
  return finish('ahwa', b, { minX, maxX, minZ, maxZ }, rr, hiders);
}

/** Ramadan alley at night: lanterns, tent bunting, string lights, foul cart, cartons, balconies, mesaharaty NPC. */
export function generateRamadanAlley(): CamoRoomData {
  const minX = -24, maxX = 24, minZ = -9, maxZ = 9;
  const b = builder();
  walls(b, minX, maxX, minZ, maxZ);
  const rr = refereeRoom(b, minX, maxZ);
  // building fronts on both sides: peeling walls and wooden doors
  for (let i = 0; i < 12; i++) {
    const x = -21 + i * 3.8;
    b.item('door', x, minZ + 0.25, 1.2, 0.2, 2.2, 'wood', { solid: false, y: 1.1 });
    b.item('door', x + 1.5, maxZ - 0.25, 1.2, 0.2, 2.2, 'wood', { solid: false, y: 1.1 });
    b.spot(x, minZ + 1.0, 0, 1, 'wood', ['stand', 'wall', 'lean_l'], 2, 'wall');
    b.spot(x + 1.5, maxZ - 1.0, 0, -1, 'wood', ['stand', 'wall', 'lean_r'], 2, 'wall');
    b.spot(x + 2.2, minZ + 1.0, 0, 1, 'concrete', ['wall', 'stand', 'bend'], 3, 'wall');
    b.spot(x + 3.2, maxZ - 1.0, 0, -1, 'concrete', ['wall', 'crouch', 'ball'], 3, 'wall');
  }
  // hanging decor (no collision): lanterns, tent bunting, light strings, balconies
  for (let i = 0; i < 16; i++) {
    b.item('lantern', -22 + i * 2.9, (i % 2 ? -1 : 1) * 2.2, 0.4, 0.4, 0.7, 'metal', { solid: false, y: 3.2 });
    b.item('bunting', -22 + i * 2.9, 0, 2.6, 8, 0.1, 'cloth', { solid: false, y: 3.6 });
  }
  for (let i = 0; i < 8; i++) b.item('balcony', -20 + i * 5.6, i % 2 ? minZ + 0.6 : maxZ - 0.6, 2.4, 1.0, 0.2, 'wood', { solid: false, y: 3.0 });
  // street furniture
  b.item('foul-cart', -8, -3, 2.0, 1.0, 1.3, 'wood', { label: 'فول وطعمية' });
  b.item('foul-cart', 14, 3.5, 2.0, 1.0, 1.3, 'wood', { label: 'عربية فول' });
  for (const [cx, cz] of [[-14, 5], [-13, 5.4], [0, -5.8], [1, -5.4], [6, 6], [7, 5.6], [18, -5], [19, -5.5]] as const) {
    b.item('carton', cx, cz, 0.8, 0.8, 0.8, 'wood', { ry: cx });
    b.spot(cx, cz + (cz > 0 ? -1.0 : 1.0), 0, cz > 0 ? -1 : 1, 'wood', ['crouch', 'ball', 'bend'], 2, 'prop');
  }
  b.item('mesaharaty', 3, 2.5, 0.8, 0.8, 1.8, 'cloth', { label: 'المسحراتي', solid: false });
  b.item('drum', 3.7, 2.5, 0.5, 0.5, 0.5, 'wood', { solid: false });
  b.item('table-iftar', -2, 6.5, 3.0, 1.0, 0.8, 'wood', { label: 'مائدة الرحمن' });
  for (let i = 0; i < 6; i++) {
    b.item('plastic-chair', -3.2 + i * 0.9, 7.6, 0.5, 0.5, 0.45, 'cloth');
    b.seat(-3.2 + i * 0.9, 7.6, 0.45);
  }
  b.spot(-2, 5.4, 0, 1, 'wood', ['crouch', 'bend', 'ball'], 2, 'prop');
  b.item('booking-banner', 22, 0, 0.1, 5, 1.2, 'cloth', { label: 'احجز ملعبك على ماتشينا', solid: false, y: 3.1 });
  b.spot(minX + 0.6, 0, 1, 0, 'concrete', ['wall', 'stand', 'lean_l'], 3, 'wall');
  b.spot(maxX - 0.6, 0, -1, 0, 'concrete', ['wall', 'stand', 'lean_r'], 3, 'wall');
  b.spot(maxX - 0.6, -6, -1, 0, 'concrete', ['wall', 'crouch'], 3, 'corner');
  b.spot(maxX - 0.6, 6, -1, 0, 'concrete', ['wall', 'crouch'], 3, 'corner');
  const hiders = Array.from({ length: 10 }, (_, i) => ({ x: round(-4.5 + i), z: 0 }));
  return finish('ramadan_alley', b, { minX, maxX, minZ, maxZ }, rr, hiders);
}

export const M2_ROOMS = [generateFiveASide, generateAhwa, generateRamadanAlley] as const;
