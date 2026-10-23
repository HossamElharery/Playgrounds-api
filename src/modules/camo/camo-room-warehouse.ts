/**
 * The grand warehouse (`warehouse`): a 52 x 36 m hall under a 12 m roof. Rows of tall steel racks make aisles and
 * crossings, with containers, crate stacks, pallets, drums, a forklift, steel columns and an office box between them.
 * It is meant to feel like a real building you can get lost in: far walls, a high ceiling and hundreds of places to hide.
 */
import { round, type CamoRoomData } from './camo-room';
import { RoomKit } from './camo-room-kit';
import { CLUTTER } from './camo-room-clutter';
import { applyPalettes } from './camo-room-palettes';

export const WAREHOUSE_HEIGHT = 12;

export function generateWarehouse(): CamoRoomData {
  const minX = -26;
  const maxX = 26;
  const minZ = -18;
  const maxZ = 18;
  const k = new RoomKit({ minX, maxX, minZ, maxZ }, WAREHOUSE_HEIGHT);
  k.walls();
  const rr = k.refereeRoom('sw');

  // Rows of racks: 6 m blocks with 2 m crossings. The first block of the two southern rows is left out where the referees' room is.
  const rows = [-14.5, -10.5, -5.5, 5.5, 10.5, 14.5];
  for (const z of rows) {
    for (const cx of [-21, -13, -5, 3, 11, 19]) {
      if (z > 9 && cx === -21) continue;
      if (z > 14 && cx === 19) continue; // the office
      k.item('shelf-rack', cx, z, 6, 1.1, 5.5, 'metal', { cover: { spacing: 1.0, kind: 'wall', surface: 'metal', every: 2 } });
    }
  }
  // Steel columns down the middle lane and along the racks
  for (const [px, pz] of [[-16, 0], [-6.5, 0], [7, 0], [16, 0], [24, 0], [-24, -8], [24, 8], [0, -16.8], [0, 16.8]] as const) k.item('pillar', px, pz, 0.7, 0.7, WAREHOUSE_HEIGHT, 'metal', { cover: { kind: 'wall', surface: 'metal' } });
  // Containers at both ends of the lane
  k.item('container', -21, -1.2, 2.4, 6, 2.6, 'metal', { cover: { spacing: 1.2, kind: 'wall', surface: 'metal' } });
  k.item('container', 22.5, 2, 2.4, 6, 2.6, 'metal', { cover: { spacing: 1.2, kind: 'wall', surface: 'metal' } });
  // Crate stacks, pallets, drums, tyres: the clutter of a working warehouse
  for (const [sx, sz] of [[-10, 2], [-2.5, -2], [10, -2.2], [13.5, 2], [-24, 3], [-12.5, -16.5], [14, -16.3], [24.5, -14]] as const) k.item('crate-stack', sx, sz, 1.6, 1.6, 2.2, 'wood', { cover: { spacing: 1.0, kind: 'wall', surface: 'wood' } });
  for (const [sx, sz] of [[-8, -2.4], [2, 2.3], [-14, 2.2], [19, -2.3], [-1, -8]] as const) k.item('pallet-load', sx, sz, 1.2, 1.2, 1.5, 'wood', { cover: { kind: 'prop', surface: 'wood', poses: ['crouch', 'ball', 'bend', 'lean_l'] } });
  for (const [dx, dz] of [[-12, 1.2], [-11.2, 1.7], [-12.3, 2.1], [4.5, -1.6], [5.3, -1.2], [-18, 8], [-17.2, 8.5], [23, -9], [23.8, -9.4], [22.7, -9.8]] as const) k.item('drum', dx, dz, 0.7, 0.7, 1.0, 'metal', { cover: { kind: 'prop', surface: 'metal', poses: ['crouch', 'ball', 'bend'] } });
  for (const [tx, tz] of [[-4, 8], [6, 8.2], [17, -8], [-20, -8], [8, -8]] as const) k.item('tire', tx, tz, 0.9, 0.9, 1.1, 'cloth', { cover: { kind: 'prop', surface: 'cloth', poses: ['crouch', 'ball', 'bend'] } });
  k.item('forklift', 9, 1.4, 2.6, 1.2, 2.1, 'metal', { ry: 0.3, cover: { spacing: 1.2, kind: 'prop', surface: 'metal', poses: ['crouch', 'bend', 'lean_l', 'ball'] } });
  // The office box in the south-east corner
  k.item('office', 20, 15, 8, 5, 3.4, 'concrete', { cover: { sides: ['n', 'w'], spacing: 1.3, kind: 'wall', surface: 'concrete' } });
  // Plain walls and corners
  k.corners();
  k.wallRun('n', -22, 22, 2.4);
  k.wallRun('e', -14, 4, 2.4);
  k.wallRun('w', -14, 6, 2.4);
  // Decoration: skylight windows, hanging lamps, beams, floor lanes, signs
  for (let x = -22; x <= 22; x += 11) {
    k.decor('skywindow', x, minZ + 0.06, 5, 2.6, 0.1, 'concrete', { y: 9 });
    k.decor('skywindow', x, maxZ - 0.06, 5, 2.6, 0.1, 'concrete', { y: 9 });
  }
  for (let z = -12; z <= 12; z += 12) {
    k.decor('skywindow', minX + 0.06, z, 0.1, 2.6, 5, 'concrete', { y: 9 });
    k.decor('skywindow', maxX - 0.06, z, 0.1, 2.6, 5, 'concrete', { y: 9 });
  }
  for (const x of [-18, -6, 6, 18]) for (const z of [-12, 0, 12]) k.decor('hang-lamp', x, z, 0.9, 0.5, 0.9, 'metal', { y: WAREHOUSE_HEIGHT - 2 });
  for (const z of [-12, 0, 12]) k.decor('beam', 0, z, 52, 0.7, 0.8, 'metal', { y: WAREHOUSE_HEIGHT - 0.6 });
  for (const x of [-20, -8, 4, 16]) k.decor('beam', x, 0, 0.8, 0.7, 36, 'metal', { y: WAREHOUSE_HEIGHT - 1.5 });
  for (const x of [-8, 8]) k.decor('lane', x, 0, 0.18, 0.02, 34, 'concrete', { y: 0.012 });
  k.decor('lane', 0, 0, 50, 0.02, 0.18, 'concrete', { y: 0.012 });
  k.decor('booking-banner', 0, maxZ - 0.1, 12, 3, 0.1, 'cloth', { label: 'احجز ملعبك على ماتشينا', y: 6 });
  k.decor('booking-banner', 0, minZ + 0.1, 12, 3, 0.1, 'cloth', { label: 'احجز ملعبك على ماتشينا', y: 6 });

  const hiders = Array.from({ length: 10 }, (_, i) => ({ x: round(-4.5 + i), z: 0.5 }));
  k.clutter(rr, CLUTTER['warehouse'].defs, CLUTTER['warehouse'].clumps, CLUTTER['warehouse'].seed, hiders);
  return applyPalettes(k.finish('warehouse', rr, hiders));
}
