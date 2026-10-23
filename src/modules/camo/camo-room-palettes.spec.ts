import { roomShapeHash } from './camo-room';
import { generateLockerRoom } from './camo-room-locker';
import { bakedShare } from './camo-room-palettes';
import { M2_ROOMS } from './camo-rooms-m2';

/**
 * A bot paints itself with colours baked from the drawn room. Change a room recipe and this fails until
 * `node tools/camo/camo-bake-palettes.mjs` (web repo) has been run again and its output committed.
 */
describe.each([generateLockerRoom, ...M2_ROOMS].map((g) => [g().id, g] as const))('baked palettes of %s', (_id, gen) => {
  const room = gen();
  it('are current: every hide spot has its six colours and the shape hash matches', () => {
    expect(room.shape).toBe(roomShapeHash(room));
    expect(bakedShare(room)).toBe(1);
  });
  it('are real colours, not a flat guess: the bands of a spot are not all the same grey', () => {
    const varied = room.hideSpots.filter((s) => new Set(s.bands).size > 1).length;
    expect(varied / room.hideSpots.length).toBeGreaterThan(0.6);
  });
});
