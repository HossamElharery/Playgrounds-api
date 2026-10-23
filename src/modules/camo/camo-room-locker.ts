/**
 * The locker room (`locker_room`): a 36 x 26 m hall that feels lived in. Locker banks on three walls, four double-sided
 * locker islands that cut the floor into aisles, pillars, clothes racks, equipment cages, massage tables, a vending
 * machine, showers, benches and the referees' room. Everything tall gets hiding places along its open sides, so the
 * room offers well over a hundred and twenty places, from a flat locker front to a tucked-away dead end.
 */
import { round, type CamoRoomData } from './camo-room';
import { RoomKit, type Side } from './camo-room-kit';
import { applyPalettes } from './camo-room-palettes';

export function generateLockerRoom(): CamoRoomData {
  const minX = -18;
  const maxX = 18;
  const minZ = -13;
  const maxZ = 13;
  const k = new RoomKit({ minX, maxX, minZ, maxZ });
  k.walls();
  const rr = k.refereeRoom('sw');

  // ── lockers ──────────────────────────────────────────────────────────────
  const lockerW = 0.6;
  const lockerD = 0.5;
  const lockerH = 2.0;
  let lockerNo = 1;
  /** A bank of `count` lockers in a row; `face` is the way the doors point. Returns nothing, adds the spots in front. */
  const bank = (cid: string, x0: number, z0: number, dir: 'x' | 'z', count: number, face: { x: number; z: number }, spots = true): void => {
    const ry = Math.atan2(face.x, face.z);
    for (let i = 0; i < count; i++) {
      const cx = dir === 'x' ? x0 + i * lockerW + lockerW / 2 : x0;
      const cz = dir === 'z' ? z0 + i * lockerW + lockerW / 2 : z0;
      const w = dir === 'x' ? lockerW : lockerD;
      const d = dir === 'x' ? lockerD : lockerW;
      k.solid(`${cid}-${i}`, { minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, minY: 0, maxY: lockerH }, 'metal');
      k.prop('locker', cx, cz, w, lockerH, d, 'metal', ry, String(lockerNo++));
    }
    if (!spots) return;
    const len = count * lockerW;
    const box =
      dir === 'x'
        ? { minX: x0, maxX: x0 + len, minZ: z0 - lockerD / 2, maxZ: z0 + lockerD / 2, minY: 0, maxY: lockerH }
        : { minX: x0 - lockerD / 2, maxX: x0 + lockerD / 2, minZ: z0, maxZ: z0 + len, minY: 0, maxY: lockerH };
    const side: Side = face.z > 0 ? 's' : face.z < 0 ? 'n' : face.x > 0 ? 'e' : 'w';
    k.cover(box, { sides: [side], spacing: 0.9, surface: 'metal', kind: 'locker' });
  };
  bank('lk-n1', -15.6, minZ + lockerD / 2, 'x', 14, { x: 0, z: 1 });
  bank('lk-n2', 4.2, minZ + lockerD / 2, 'x', 14, { x: 0, z: 1 });
  bank('lk-w', minX + lockerD / 2, -9, 'z', 12, { x: 1, z: 0 });
  bank('lk-e', maxX - lockerD / 2, -9, 'z', 12, { x: -1, z: 0 });
  bank('lk-w2', minX + lockerD / 2, 1.8, 'z', 8, { x: 1, z: 0 });
  bank('lk-e2', maxX - lockerD / 2, 1.8, 'z', 8, { x: -1, z: 0 });

  // Four double-sided locker islands: doors on both long sides, so the middle of the hall is a set of aisles.
  for (const cx of [-11, -5, 5, 11]) {
    const cz = -5.2;
    const x0 = cx - 1.8;
    for (let i = 0; i < 6; i++) {
      k.prop('locker', x0 + i * lockerW + lockerW / 2, cz - 0.25, lockerW, lockerH, lockerD, 'metal', Math.PI, String(lockerNo++));
      k.prop('locker', x0 + i * lockerW + lockerW / 2, cz + 0.25, lockerW, lockerH, lockerD, 'metal', 0, String(lockerNo++));
    }
    k.solid(`island-${cx}`, { minX: x0, maxX: x0 + 3.6, minZ: cz - 0.5, maxZ: cz + 0.5, minY: 0, maxY: lockerH }, 'metal');
    k.cover({ minX: x0, maxX: x0 + 3.6, minZ: cz - 0.5, maxZ: cz + 0.5, minY: 0, maxY: lockerH }, { spacing: 0.9, surface: 'metal', kind: 'locker' });
  }

  // ── benches ──────────────────────────────────────────────────────────────
  const benchH = 0.45;
  const bench = (cx: number, cz: number, w: number, d: number, vertical: boolean): void => {
    const bw = vertical ? d : w;
    const bd = vertical ? w : d;
    k.item('bench', cx, cz, bw, bd, benchH, 'wood', { cover: { sides: vertical ? ['e', 'w'] : ['n', 's'], every: 2, kind: 'bench', poses: ['sit', 'crouch', 'ball'] } });
    k.seat(cx, cz, benchH);
  };
  for (const x of [-12, -6, 0, 6, 12]) bench(x, -9, 2.6, 0.5, false);
  for (const z of [-5, -1, 3]) {
    bench(-15, z, 2.6, 0.5, true);
    bench(15, z, 2.6, 0.5, true);
  }
  bench(0, 6.5, 3.0, 0.5, false);

  // ── the middle: tactics corner, pillars, clothes racks, massage tables ───────
  k.item('tactics-table', 0, -1, 2.6, 1.2, 0.9, 'wood', { cover: { sides: ['n', 's'], every: 2, kind: 'prop', poses: ['crouch', 'bend', 'ball'] } });
  k.item('tactics-board', 0, -4.2, 2.4, 0.15, 1.8, 'metal', { cover: { sides: ['n', 's'], spacing: 1.2, kind: 'prop' } });
  for (const [px, pz] of [[-10.5, 1.5], [10.5, 1.5], [0, 2.6], [-5, 7.5], [5, 7.5]] as const) k.item('pillar', px, pz, 0.6, 0.6, 4, 'concrete', { cover: { kind: 'wall', surface: 'concrete' } });
  for (const [rx, rz] of [[-7, 4.8], [7, 4.8], [-6.5, 10.2], [3.8, 10.4]] as const) k.item('rack', rx, rz, 2.4, 0.5, 1.9, 'cloth', { cover: { spacing: 1.0, kind: 'wall', surface: 'cloth' } });
  for (const [mx, mz] of [[-9.5, 7.2], [9.5, 7.2]] as const) k.item('massage-table', mx, mz, 0.8, 1.9, 0.7, 'wood', { cover: { sides: ['e', 'w'], spacing: 1.0, kind: 'prop', poses: ['crouch', 'flat', 'ball'] } });
  k.item('ice-tub', -8, 11.5, 1.8, 0.9, 0.9, 'metal', { cover: { sides: ['n'], kind: 'prop', poses: ['crouch', 'ball'] } });
  for (const [cx, cz] of [[-5, 10], [-3, 10.8], [8, 9]] as const) k.item('water-crate', cx, cz, 0.7, 0.5, 0.5, 'wood', { cover: { sides: ['n'], kind: 'prop' } });
  for (const [bx, bz] of [[13.5, 9.8], [15, 7.6]] as const) k.item('ball-net', bx, bz, 1.0, 1.0, 1.1, 'cloth', { cover: { sides: ['n', 'w'], kind: 'prop', poses: ['crouch', 'ball'] } });
  for (let i = 0; i < 6; i++) k.item('cone', -7 + i * 0.9, 12.2, 0.3, 0.3, 0.4, 'cloth');

  // ── south wall: cages, a cooler, a vending machine, shelves ─────────────────
  for (const cx of [-10.5, -7, -3.5]) k.item('cage', cx, 12.5, 2.0, 0.8, 1.9, 'metal', { cover: { sides: ['n'], spacing: 1.0, kind: 'wall', surface: 'metal' } });
  k.item('cooler', 0, 12.65, 0.45, 0.45, 1.5, 'metal', { cover: { sides: ['n', 'e', 'w'], kind: 'wall' } });
  k.item('vending', 2.3, 12.5, 0.9, 0.8, 1.9, 'metal', { cover: { sides: ['n', 'e'], kind: 'wall' } });
  k.item('shelf', 5.9, 12.6, 2.2, 0.6, 2.1, 'wood', { cover: { sides: ['n'], spacing: 1.0, kind: 'wall', surface: 'wood' } });
  for (const bx of [-2, 7.8]) k.item('bin', bx, 11.8, 0.6, 0.6, 0.9, 'cloth', { cover: { sides: ['n'], kind: 'prop', poses: ['crouch', 'ball'] } });

  // ── north wall, between the banks: shelves and the poster ───────────────────
  k.item('shelf', -4.6, -12.55, 2.8, 0.55, 2.2, 'wood', { cover: { sides: ['s'], spacing: 0.9, kind: 'wall', surface: 'wood' } });
  k.item('shelf', 0.4, -12.55, 2.8, 0.55, 2.2, 'wood', { cover: { sides: ['s'], spacing: 0.9, kind: 'wall', surface: 'wood' } });

  // ── showers (south-east): tiled stalls with thin partitions ──────────────────
  for (let i = 0; i < 5; i++) k.item('shower-wall', 10.3 + i * 1.6, 10.5, 0.1, 2.4, 2.0, 'tile', { cover: { sides: ['e'], spacing: 1.3, offset: 0.4, kind: 'shower', surface: 'tile' } });
  k.item('shower-wall', 9.5, 10.5, 0.1, 2.4, 2.0, 'tile', { cover: { sides: ['w'], spacing: 1.3, offset: 0.4, kind: 'shower', surface: 'tile' } });
  k.item('shower-back', 13.5, 12.2, 8.2, 0.2, 2.4, 'tile', { cover: { sides: ['n'], spacing: 1.7, offset: 0.4, kind: 'shower', surface: 'tile' } });

  // ── plain walls and corners ────────────────────────────────────────────────
  k.wallRun('w', -1.2, 1.2, 1.2);
  k.wallRun('e', -1.2, 1.2, 1.2);
  k.wallRun('n', -7, -6, 1);
  k.wallRun('s', -1, 17, 1.7);
  k.wallRun('e', 6.8, 8.6, 1);
  k.corners();

  // ── decoration that nothing collides with: posters, jerseys, a bulletin board, a clock, kit left about ──
  k.decor('poster-book', -9, minZ + 0.05, 3.2, 2.2, 0.05, 'concrete', { label: 'احجز ملعبك على ماتشينا', y: 2.0 });
  k.decor('tunnel', maxX - 0.05, 2, 0.1, 3, 4, 'concrete', { ry: Math.PI / 2, label: 'النفق', y: 1.5 });
  for (let i = 0; i < 10; i++) k.decor('jersey', -13 + i * 2.7, minZ + 1.1, 0.5, 0.7, 0.05, 'cloth', { label: String((i % 11) + 1), y: 1.9 });
  const posters: Array<[string, number, number, number, number, number]> = [
    // type, x, z, w, h, ry
    ['poster-a', -2.5, minZ + 0.05, 1.2, 1.7, 0],
    ['poster-b', 2.5, minZ + 0.05, 1.2, 1.7, 0],
    ['poster-c', 14.6, minZ + 0.05, 1.6, 1.1, 0],
    ['poster-d', -17.2, minZ + 0.05, 1.6, 1.1, 0],
    ['poster-a', maxX - 0.05, 9.5, 1.2, 1.7, Math.PI / 2],
    ['poster-c', maxX - 0.05, -11, 1.4, 1.0, Math.PI / 2],
    ['poster-b', minX + 0.05, -11, 1.4, 1.0, Math.PI / 2],
    ['poster-d', minX + 0.05, 0, 1.2, 1.6, Math.PI / 2],
    ['poster-b', -8, maxZ - 0.05, 1.6, 1.1, 0],
    ['poster-a', 12, maxZ - 0.05, 1.4, 1.0, 0],
  ];
  for (const [t, x, z, w, h, ry] of posters) k.decor(t, x, z, ry ? 0.05 : w, h, ry ? w : 0.05, 'cloth', { ry, y: 2.5 });
  k.decor('board', minX + 0.06, 6.2, 0.06, 1.0, 1.8, 'wood', { y: 1.7 });
  k.decor('clock', 0, minZ + 0.06, 0.6, 0.6, 0.05, 'metal', { y: 3.2 });
  k.decor('flicker-lamp', -16, -11, 0.4, 0.1, 0.4, 'metal', { label: 'flicker', y: 3.9 });
  // towels on benches, shoes and bags on the floor: deterministic, a handful per area
  let n = 0;
  for (const x of [-12, -6, 0, 6, 12]) k.decor('towel', x + ((n++ % 3) - 1) * 0.5, -9, 0.5, 0.05, 0.3, 'cloth', { y: benchH + 0.03 });
  for (const [sx, sz] of [[-14, -11.6], [-3.8, -11.7], [7.2, -11.7], [11.6, -11.6], [-16.8, -7], [16.8, -4], [-16.8, 3], [-1, 11.4], [-12.5, 6.8], [12.5, 12.4]] as const) k.decor('shoes', sx, sz, 0.3, 0.12, 0.22, 'cloth', { y: 0.06 });
  for (const [bx, bz] of [[-13.5, 5.5], [-2.2, 9], [14, 4.8], [2, -7.6], [-16, -3]] as const) k.decor('bag', bx, bz, 0.55, 0.3, 0.3, 'cloth', { y: 0.15 });

  const hiders: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < 10; i++) hiders.push({ x: round(-4.5 + i), z: 4.2 });
  return applyPalettes(k.finish('locker_room', rr, hiders));
}
