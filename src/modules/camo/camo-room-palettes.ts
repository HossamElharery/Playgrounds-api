/**
 * The colours behind every hide spot, baked from the drawn room (`tools/camo/camo-bake-palettes.mjs` in the web repo,
 * which writes `camo-room-palettes.data.ts`). A bot paints itself with them, so it vanishes into the true wall and not
 * into a guess. The bake stores the room's shape hash; when the recipe changes without a new bake the data is ignored
 * and the spec `camo-room-palettes.spec.ts` fails, so a stale bake cannot ship.
 */
import { roomShapeHash, type CamoRoomData } from './camo-room';
import { PALETTE_DATA } from './camo-room-palettes.data';

/** Stamps the room with its shape hash and, when the bake is current, with the baked colours. */
export function applyPalettes(room: CamoRoomData): CamoRoomData {
  room.shape = roomShapeHash(room);
  const data = PALETTE_DATA[room.id];
  if (!data || data.shape !== room.shape) return room;
  for (const s of room.hideSpots) {
    const bands = data.spots[s.id];
    if (bands && bands.length === 6) s.bands = bands.slice();
  }
  return room;
}

/** Spots a current bake covers (for the spec and the admin overview). */
export function bakedShare(room: CamoRoomData): number {
  return room.hideSpots.length ? room.hideSpots.filter((s) => s.bands?.length === 6).length / room.hideSpots.length : 0;
}
