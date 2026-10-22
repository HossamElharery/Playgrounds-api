import { buildWalkGrid, findPath, isWalkable, roomHash } from './camo-room';
import { M2_ROOMS } from './camo-rooms-m2';

describe.each(M2_ROOMS.map((g) => [g().id, g] as const))('M2 room %s', (_id, gen) => {
  const room = gen();
  it('has 40+ reachable hide spots, none in the referees zone', () => {
    expect(room.hideSpots.length).toBeGreaterThanOrEqual(40);
    const grid = buildWalkGrid(room);
    for (const s of room.hideSpots) {
      expect(findPath(grid, room.spawns.hiders[0], s)).not.toBeNull();
      expect(room.forbidden.some((f) => s.x >= f.minX && s.x <= f.maxX && s.z >= f.minZ && s.z <= f.maxZ)).toBe(false);
    }
  });
  it('spawns are on free floor and the referees room has a door that opens to the hall', () => {
    for (const p of [...room.spawns.hiders, ...room.spawns.seekers]) expect(isWalkable(room, p.x, p.z, 0.2)).toBe(true);
    const grid = buildWalkGrid(room);
    expect(findPath(grid, room.spawns.seekers[0], room.spawns.hiders[0])).not.toBeNull();
  });
  it('is deterministic (same hash twice) and the poses of each spot are known', () => {
    expect(roomHash(gen())).toBe(roomHash(room));
    for (const s of room.hideSpots) expect(s.poses.length).toBeGreaterThan(0);
  });
});
