import { round, type CamoRoomData } from './camo-room';
import { RoomKit } from './camo-room-kit';
import { applyPalettes } from './camo-room-palettes';

/**
 * The three M2 rooms (section 9), generated from recipes with the shared `RoomKit` so the server and the client agree.
 * Each has well over a hundred hide spots, a referees' room with a door, seats and walk-grid reachability checks.
 */

/** A row of identical solid things; `cover` asks for hiding places around each. */
const row = (n: number, fn: (i: number) => void): void => {
  for (let i = 0; i < n; i++) fn(i);
};

const hidersRow = (n: number, x0: number, z: number): Array<{ x: number; z: number }> => Array.from({ length: n }, (_, i) => ({ x: round(x0 + i), z }));

/** Five-a-side at night: artificial grass, fence posts, goals, containers, a subs bench, a snack kiosk, a parked car. */
export function generateFiveASide(): CamoRoomData {
  const minX = -22;
  const maxX = 22;
  const minZ = -15;
  const maxZ = 15;
  const k = new RoomKit({ minX, maxX, minZ, maxZ });
  k.walls();
  const rr = k.refereeRoom('sw');
  // goals at both ends, with their nets
  for (const sx of [-1, 1]) {
    k.item('goal', sx * 19.5, 0, 0.3, 7, 2.4, 'metal', { cover: { sides: [sx < 0 ? 'e' : 'w'], spacing: 1.2, kind: 'prop', surface: 'metal' } });
    k.item('goal-net', sx * 20.5, 0, 1.5, 7, 2.4, 'cloth', { solid: false });
    k.spot(sx * 20.6, 0, -sx, 0, 'cloth', ['crouch', 'ball', 'flat'], 'prop', 3);
  }
  // fence posts along both long sides, with a bench-high kerb between them to tuck behind
  row(14, (i) => {
    const x = -19.5 + i * 3;
    k.item('fence-post', x, minZ + 1.2, 0.2, 0.2, 2.6, 'metal', { cover: { sides: ['s'], kind: 'wall', surface: 'metal' } });
    k.item('fence-post', x, maxZ - 1.2, 0.2, 0.2, 2.6, 'metal', { cover: { sides: ['n'], kind: 'wall', surface: 'metal' } });
  });
  // shipping containers and dugouts: big tall cover in a ring around the pitch
  for (const [cx, cz, ry] of [[-14, -12.6, 0], [-1, -12.8, 0], [13, -12.6, 0], [-16, 6.5, Math.PI / 2], [16, 8.5, Math.PI / 2]] as const) {
    k.item('container', cx, cz, 6, 2.4, 2.6, 'metal', { ry, cover: { spacing: 1.2, kind: 'wall', surface: 'metal' } });
  }
  for (const [cx, cz] of [[-11, 5], [11, -5], [0, 9.5]] as const) k.item('dugout', cx, cz, 3, 1.2, 2.2, 'wood', { cover: { spacing: 1.0, kind: 'wall', surface: 'wood' } });
  // tyres, barrels, pallets: the clutter of a real five-a-side lot
  for (const [tx, tz] of [[-7, -6], [-6.2, -6.6], [7, 7], [7.8, 7.5], [0, -4], [-1, -3.4], [10, -9], [-10, 10]] as const) k.item('tire', tx, tz, 0.9, 0.9, 1.1, 'cloth', { cover: { kind: 'prop', surface: 'cloth', poses: ['crouch', 'ball', 'bend'] } });
  for (const [bx, bz] of [[-4, 9.8], [-3, 10.4], [4, -9.8], [5, -10.4], [15, 0], [-15, -4], [3, 5], [-8, 0]] as const) k.item('barrel', bx, bz, 0.7, 0.7, 1.0, 'metal', { cover: { kind: 'prop', surface: 'metal', poses: ['crouch', 'ball', 'bend'] } });
  for (const [px, pz] of [[-20, 5], [19, -10], [8, 12.4], [-8, -9]] as const) k.item('stack', px, pz, 1.3, 1.3, 1.6, 'wood', { cover: { spacing: 1.0, kind: 'wall', surface: 'wood' } });
  // subs bench, snack kiosk, plastic chairs, a parked car, floodlights
  k.item('subs-bench', -8, minZ + 2.4, 5, 0.6, 0.5, 'wood', { cover: { sides: ['s'], kind: 'bench', poses: ['sit', 'crouch'] } });
  row(5, (i) => k.seat(-10 + i, minZ + 2.4, 0.5));
  k.item('kiosk', 12, maxZ - 3, 4.5, 2.4, 2.6, 'wood', { label: 'شيبسي وبيبسي', cover: { sides: ['n', 'w', 'e'], spacing: 1.1, kind: 'wall', surface: 'wood' } });
  k.item('chips-stack', 9.2, maxZ - 2.2, 0.8, 0.8, 1.2, 'cloth', { label: 'شيبسي', cover: { sides: ['n', 'w'], kind: 'prop', surface: 'cloth' } });
  row(6, (i) => {
    const cx = 5 + (i % 3) * 1.2;
    const cz = maxZ - 6 - Math.floor(i / 3) * 1.2;
    k.item('plastic-chair', cx, cz, 0.5, 0.5, 0.45, 'cloth', { ry: i });
    k.seat(cx, cz, 0.45);
  });
  k.decor('booking-board', maxX - 0.3, -6, 0.2, 2.2, 4, 'metal', { label: 'احجز ملعبك على ماتشينا', y: 1.6 });
  k.item('parked-car', maxX - 3, minZ + 2.5, 4.2, 1.8, 1.4, 'metal', { cover: { sides: ['s', 'w'], spacing: 1.1, kind: 'prop', surface: 'metal', poses: ['crouch', 'bend', 'ball', 'lean_l'] } });
  row(6, (i) => k.item('cone', -6 + i * 2.4, 8, 0.3, 0.3, 0.4, 'cloth'));
  k.item('floodlight', -12, minZ + 0.6, 0.5, 0.5, 4.5, 'metal', { cover: { sides: ['s'], kind: 'wall', surface: 'metal' } });
  k.item('floodlight', 12, maxZ - 0.6, 0.5, 0.5, 4.5, 'metal', { cover: { sides: ['n'], kind: 'wall', surface: 'metal' } });
  // plain walls and corners
  k.corners();
  k.wallRun('w', -10, 4, 1.6);
  k.wallRun('e', -13, 6, 1.6);
  k.wallRun('n', -20, 20, 2.2, 'concrete');
  k.wallRun('s', -4, 20, 2.2, 'concrete');
  return applyPalettes(k.finish('five_a_side', rr, hidersRow(10, -5, 0.5)));
}

/** The traditional ahwa during a match: wicker chairs, marble tables, shisha, TV, backgammon, curtain, columns, sofas. */
export function generateAhwa(): CamoRoomData {
  const minX = -16;
  const maxX = 16;
  const minZ = -12;
  const maxZ = 12;
  const k = new RoomKit({ minX, maxX, minZ, maxZ });
  k.walls();
  const rr = k.refereeRoom('sw');
  // marble tables with four wicker chairs each
  const tables: Array<[number, number]> = [[-8, -6], [0, -6], [8, -6], [-8, 0], [0, 0], [8, 0], [-4, 6], [4, 6], [12, 6]];
  tables.forEach(([tx, tz], i) => {
    k.item('marble-table', tx, tz, 0.9, 0.9, 0.75, 'tile');
    // the table and its four chairs make one low island: a body folds down beside it
    k.cover({ minX: tx - 1.15, maxX: tx + 1.15, minZ: tz - 1.15, maxZ: tz + 1.15, minY: 0, maxY: 0.9 }, { spacing: 1.2, offset: 0.45, every: 1, kind: 'prop', surface: 'tile', poses: ['crouch', 'bend', 'ball', 'sit'] });
    if (i % 2 === 0) k.decor('shisha', tx + 0.1, tz, 0.3, 1.0, 0.3, 'metal', { y: 1.25 });
    for (const [dx, dz] of [[-0.9, 0], [0.9, 0], [0, -0.9], [0, 0.9]] as const) {
      k.item('wicker-chair', tx + dx, tz + dz, 0.5, 0.5, 0.9, 'wood', { ry: Math.atan2(dx, dz) });
      k.seat(tx + dx, tz + dz, 0.45);
    }
  });
  // columns, booth screens and sofas break the room into corners
  for (const [cx, cz] of [[-4, -3], [4, -3], [-12, -2], [12, -2], [-4, 11], [4, 11], [-12, -8.5], [12, -8.5], [-4, -9], [4, -9], [-9, 9], [12, 11]] as const) k.item('column', cx, cz, 0.7, 0.7, 4, 'concrete', { cover: { kind: 'wall', surface: 'concrete' } });
  for (const [sx, sz, ry] of [[-4, 3, Math.PI / 2], [4, 3, Math.PI / 2], [-12, 3.5, 0], [0, 9, 0], [-8, -3, Math.PI / 2], [8, -3, Math.PI / 2], [-8, 9.5, 0], [8, 9, 0], [0, -9.5, 0]] as const) k.item('screen', sx, sz, 2.4, 0.15, 1.9, 'wood', { ry, cover: { spacing: 1.2, kind: 'wall', surface: 'wood' } });
  for (const [sx, sz] of [[-6, maxZ - 0.7], [6, maxZ - 0.7], [11, minZ + 0.7]] as const) k.item('sofa', sx, sz, 2.4, 0.9, 1.0, 'cloth', { cover: { sides: [sz > 0 ? 'n' : 's'], spacing: 1.0, kind: 'prop', surface: 'cloth', poses: ['crouch', 'sit', 'ball', 'bend'] } });
  for (const [cx, cz] of [[-15.4, -8], [-15.4, 8], [15.4, 8], [15.4, -9], [-15.4, -4], [-15.4, 0], [15.4, 2], [15.4, -5], [-9, minZ + 0.4], [-14, minZ + 0.4], [-2, minZ + 0.4]] as const) k.item('cabinet', cx, cz, 0.5, 1.4, 2.1, 'wood', { ry: Math.abs(cx) < 14.5 ? Math.PI / 2 : 0, cover: { sides: [cx < -14 ? 'e' : cx > 14 ? 'w' : 's'], spacing: 1.0, kind: 'wall', surface: 'wood' } });
  k.item('fridge', 13.5, minZ + 0.6, 0.9, 0.7, 1.9, 'metal', { cover: { sides: ['s', 'w'], kind: 'wall', surface: 'metal' } });
  for (const [px, pz] of [[-14.5, -11], [14.5, 11], [-14.5, 1], [14.5, -3]] as const) k.item('plant', px, pz, 0.7, 0.7, 1.4, 'cloth', { cover: { kind: 'prop', surface: 'cloth', poses: ['crouch', 'ball', 'bend'] } });
  // the TV wall, the national-team photo, the tea corner, the curtain, the games
  k.decor('tv', 0, minZ + 0.3, 3.2, 1.8, 0.2, 'concrete', { label: 'tv-match', y: 2.2 });
  k.decor('old-photo', -10, minZ + 0.1, 1.6, 1.1, 0.1, 'concrete', { label: 'المنتخب 1990', y: 2.0 });
  k.item('tea-counter', 12, minZ + 1.2, 5, 1.2, 1.1, 'wood', { label: 'واحد شاي!', cover: { sides: ['s'], spacing: 1.1, kind: 'wall', surface: 'wood' } });
  k.decor('tea-kettles', 11, minZ + 1.2, 0.5, 0.5, 0.5, 'metal', { y: 1.4 });
  k.item('curtain', maxX - 0.4, 2, 0.15, 5, 2.8, 'cloth', { cover: { sides: ['w'], spacing: 1.2, kind: 'wall', surface: 'cloth' } });
  k.item('tawla-table', -13.5, 3.4, 1.4, 1.0, 0.75, 'wood', { label: 'طاولة', cover: { kind: 'prop', surface: 'wood', poses: ['crouch', 'bend', 'ball'] } });
  k.item('domino-table', -13.5, 0.6, 1.4, 1.0, 0.75, 'wood', { label: 'دومينو', cover: { kind: 'prop', surface: 'wood', poses: ['crouch', 'bend', 'ball'] } });
  k.decor('booking-poster', maxX - 0.1, -4, 0.1, 2.6, 2.0, 'concrete', { label: 'احجز ملعبك على ماتشينا', y: 1.8 });
  k.corners();
  k.wallRun('w', -10, -3, 1.6, 'tile');
  k.wallRun('n', -14, 8, 1.8, 'tile');
  k.wallRun('s', -14, 14, 2.2, 'tile');
  k.wallRun('e', -1, 9, 1.6, 'tile');
  return applyPalettes(k.finish('ahwa', rr, hidersRow(10, -4.5, 3)));
}

/** Ramadan alley at night: lanterns, tent bunting, string lights, foul carts, cartons, stalls, balconies, the mesaharaty. */
export function generateRamadanAlley(): CamoRoomData {
  const minX = -24;
  const maxX = 24;
  const minZ = -9;
  const maxZ = 9;
  const k = new RoomKit({ minX, maxX, minZ, maxZ });
  k.walls();
  const rr = k.refereeRoom('sw');
  // building fronts on both sides: wooden doors, recessed corners, window grilles
  row(12, (i) => {
    const x = -21 + i * 3.8;
    k.decor('door', x, minZ + 0.25, 1.2, 2.2, 0.2, 'wood', { y: 1.1 });
    k.decor('door', x + 1.5, maxZ - 0.25, 1.2, 2.2, 0.2, 'wood', { y: 1.1 });
  });
  k.wallRun('n', -22, 22, 1.3, 'wood');
  k.wallRun('s', -9, 22, 1.3, 'wood');
  // hanging decoration: lanterns, tent bunting, balconies
  row(16, (i) => {
    k.decor('lantern', -22 + i * 2.9, (i % 2 ? -1 : 1) * 2.2, 0.4, 0.7, 0.4, 'metal', { y: 3.2 });
    k.decor('bunting', -22 + i * 2.9, 0, 2.6, 0.1, 8, 'cloth', { y: 3.6 });
  });
  row(8, (i) => k.decor('balcony', -20 + i * 5.6, i % 2 ? minZ + 0.6 : maxZ - 0.6, 2.4, 0.2, 1.0, 'wood', { y: 3.0 }));
  // street stalls with canvas roofs, carts, cartons, sacks, crates: the middle of the street is a market
  for (const [sx, sz] of [[-17, -6.5], [-9, 6.6], [-2, -6.6], [6, 6.5], [13, -6.5], [19, 6.6], [-14, 6.5], [21, -6.6]] as const) k.item('stall', sx, sz, 2.6, 1.4, 2.2, 'cloth', { cover: { spacing: 1.1, kind: 'wall', surface: 'cloth' } });
  for (const [cx, cz] of [[-8, -3], [14, 3.5], [-15, 2], [2, -2.2], [-1, 3.6]] as const) k.item('foul-cart', cx, cz, 2.0, 1.0, 1.3, 'wood', { label: cx === -8 ? 'فول وطعمية' : cx === 14 ? 'عربية فول' : undefined, cover: { spacing: 1.2, kind: 'prop', surface: 'wood', poses: ['crouch', 'bend', 'ball', 'lean_l'] } });
  for (const [cx, cz] of [[-14, 5], [-13, 5.4], [0, -5.8], [1, -5.4], [6, 3.5], [7, 3.1], [18, -4], [19, -4.5], [-5, 2.5], [11, -2.5]] as const) k.item('carton', cx, cz, 0.9, 0.9, 1.1, 'wood', { ry: cx, cover: { kind: 'prop', surface: 'wood', poses: ['crouch', 'ball', 'bend'] } });
  for (const [cx, cz] of [[-11, -1], [4, 2.2], [16, -1.2], [-19, -3]] as const) k.item('sack', cx, cz, 0.8, 0.8, 0.8, 'cloth', { cover: { kind: 'prop', surface: 'cloth', poses: ['crouch', 'ball'] } });
  for (const [px, pz] of [[-6, -1.6], [8, 1.8], [-20, 0], [20, 0], [0, 4.4]] as const) k.item('pole', px, pz, 0.3, 0.3, 4, 'metal', { cover: { kind: 'wall', surface: 'metal' } });
  k.item('mesaharaty', 3, 2.5, 0.8, 0.8, 1.8, 'cloth', { label: 'المسحراتي', cover: { sides: ['n'], kind: 'prop', surface: 'cloth' } });
  k.decor('drum', 3.7, 2.5, 0.5, 0.5, 0.5, 'wood', { y: 0.25 });
  k.item('table-iftar', -2, 6.5, 3.0, 1.0, 0.8, 'wood', { label: 'مائدة الرحمن', cover: { sides: ['n'], kind: 'prop', surface: 'wood', poses: ['crouch', 'bend', 'ball'] } });
  row(6, (i) => {
    k.item('plastic-chair', -3.2 + i * 0.9, 7.6, 0.5, 0.5, 0.45, 'cloth');
    k.seat(-3.2 + i * 0.9, 7.6, 0.45);
  });
  k.decor('booking-banner', 22, 0, 0.1, 1.2, 5, 'cloth', { label: 'احجز ملعبك على ماتشينا', y: 3.1 });
  k.corners();
  k.spot(maxX - 0.6, -6, -1, 0, 'concrete', ['wall', 'crouch'], 'corner', 3);
  k.spot(maxX - 0.6, 6, -1, 0, 'concrete', ['wall', 'crouch'], 'corner', 3);
  return applyPalettes(k.finish('ramadan_alley', rr, hidersRow(10, -4.5, 0)));
}

export const M2_ROOMS = [generateFiveASide, generateAhwa, generateRamadanAlley] as const;
