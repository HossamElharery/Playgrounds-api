import {
  buildWalkGrid,
  findPath,
  insideAabb2d,
  isWalkable,
  lineBlocked,
  pushOut,
  roomHash,
} from './camo-room';
import { generateLockerRoom } from './camo-room-locker';

describe('camo locker room', () => {
  const room = generateLockerRoom();
  const grid = buildWalkGrid(room);

  it('is a 600-1200 m2 hall with at least 120 hide spots of every difficulty', () => {
    const b = room.bounds;
    const area = (b.maxX - b.minX) * (b.maxZ - b.minZ);
    expect(area).toBeGreaterThanOrEqual(600);
    expect(area).toBeLessThanOrEqual(1200);
    expect(room.hideSpots.length).toBeGreaterThanOrEqual(120);
    for (const d of [1, 2, 3]) expect(room.hideSpots.filter((s) => s.difficulty === d).length).toBeGreaterThanOrEqual(20);
  });

  it('is generated the same way every time (stable hash)', () => {
    expect(roomHash(generateLockerRoom())).toBe(roomHash(room));
  });

  it('keeps every hide spot walkable, outside the forbidden zones and reachable from both spawns', () => {
    const start = room.spawns.hiders[0];
    const exit = room.spawns.seekers[0];
    const bad: string[] = [];
    for (const s of room.hideSpots) {
      if (!isWalkable(room, s.x, s.z)) bad.push(`${s.id} not walkable`);
      for (const f of room.forbidden) if (insideAabb2d(s.x, s.z, f)) bad.push(`${s.id} forbidden`);
      if (!findPath(grid, start, s)) bad.push(`${s.id} unreachable from hider spawn`);
      if (!findPath(grid, exit, s)) bad.push(`${s.id} unreachable from the referee room`);
      if (!s.poses.length) bad.push(`${s.id} has no poses`);
    }
    expect(bad).toEqual([]);
  });

  it('puts the spawns on free floor and the referees inside their own room', () => {
    for (const p of room.spawns.hiders) expect(isWalkable(room, p.x, p.z)).toBe(true);
    for (const p of room.spawns.seekers) {
      expect(isWalkable(room, p.x, p.z)).toBe(true);
      expect(insideAabb2d(p.x, p.z, room.refereeRoom)).toBe(true);
    }
  });

  it('pushes a point out of a locker and back into the hall', () => {
    const locker = room.colliders.find((c) => c.id === 'lk-n1-3')!;
    const p = pushOut(room, (locker.minX + locker.maxX) / 2, (locker.minZ + locker.maxZ) / 2);
    expect(isWalkable(room, p.x, p.z)).toBe(true);
    const far = pushOut(room, 200, 200);
    expect(isWalkable(room, far.x, far.z)).toBe(true);
  });

  it('blocks sight through lockers but not through the open hall', () => {
    expect(lineBlocked(room, -8, 0, -8, -12.9)).toBe(true);
    expect(lineBlocked(room, -8, 2, -2, 3)).toBe(false);
  });

  it('finds no path into a solid wall region and routes around obstacles otherwise', () => {
    const path = findPath(grid, { x: -16, z: 11 }, { x: 16, z: -11 });
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(20);
  });
});
