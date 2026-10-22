import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BALL_RADIUS, launchVelocity, simulateShot, type ShotResult } from './camo-ball-sim';
import { generateLockerRoom } from './camo-room';
import { inForbiddenZone, kickOriginOk, tagHits, travelBudget } from './camo-hit';

const room = generateLockerRoom();

interface Scenario {
  name: string;
  origin: { x: number; y: number; z: number };
  dir: [number, number, number];
  power: number;
  lob: boolean;
  targets: Array<{ id: number; x: number; z: number }>;
}

const SCENARIOS: Scenario[] = [
  { name: 'direct-miss', origin: { x: 0, y: 1.1, z: 5 }, dir: [0, 0, -1], power: 1, lob: false, targets: [] },
  { name: 'direct-hit', origin: { x: 0, y: 1.1, z: 6 }, dir: [0, -0.02, -1], power: 1, lob: false, targets: [{ id: 3, x: 0, z: 2 }] },
  { name: 'lob-over-bench', origin: { x: 8, y: 1.1, z: 6 }, dir: [-1, 0, -0.3], power: 0.6, lob: true, targets: [{ id: 1, x: 3, z: 4 }] },
  { name: 'locker-ricochet', origin: { x: -9, y: 1.1, z: -6 }, dir: [0, 0, -1], power: 1, lob: false, targets: [{ id: 7, x: -9, z: -8.2 }] },
  { name: 'wall-bank', origin: { x: 10, y: 1.1, z: 2 }, dir: [1, 0, 0.1], power: 1, lob: false, targets: [{ id: 2, x: 12, z: 2.8 }] },
  { name: 'two-targets', origin: { x: -2, y: 1.1, z: 8 }, dir: [0, -0.05, -1], power: 1, lob: false, targets: [{ id: 4, x: -2, z: 5 }, { id: 5, x: -2, z: 0 }] },
];

const run = (s: Scenario): ShotResult => {
  const v = launchVelocity(s.dir[0], s.dir[1], s.dir[2], s.power, s.lob);
  return simulateShot(room, s.origin, v, s.targets);
};

/** Compact, rounded form kept in the shared fixture (the client compares against the same file). */
const summary = (r: ShotResult) => ({
  end: [r.end.t, r.end.x, r.end.y, r.end.z].map((n) => Math.round(n * 1e6) / 1e6),
  events: r.events.map((e) => [e.kind, Math.round(e.t * 1e6) / 1e6, Math.round(e.x * 1e6) / 1e6, Math.round(e.z * 1e6) / 1e6, e.target ?? -1, e.ricochet ? 1 : 0]),
  keyframes: r.keyframes.length,
});

describe('camo ball sim', () => {
  it('is deterministic', () => {
    for (const s of SCENARIOS) expect(JSON.stringify(summary(run(s)))).toBe(JSON.stringify(summary(run(s))));
  });

  it('matches the shared fixture the client also checks (to 1e-6)', () => {
    const file = join(__dirname, 'camo-ball-sim.fixture.json');
    const current = Object.fromEntries(SCENARIOS.map((s) => [s.name, summary(run(s))]));
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ room: { bounds: room.bounds, colliders: room.colliders }, scenarios: SCENARIOS, expected: current }, null, 1));
    const fixture = JSON.parse(readFileSync(file, 'utf8')) as { expected: typeof current };
    expect(current).toEqual(fixture.expected);
  });

  it('hits a hider that stands in the way, once', () => {
    const r = run(SCENARIOS[1]);
    const hits = r.events.filter((e) => e.kind === 'hit');
    expect(hits.length).toBe(1);
    expect(hits[0].target).toBe(3);
    expect(hits[0].ricochet).toBe(false);
    expect(r.firstHitDistance).toBeGreaterThan(3);
  });

  it('flies past a hider that is not in the line of fire', () => {
    const r = simulateShot(room, { x: 0, y: 1.1, z: 6 }, launchVelocity(0, 0, -1, 1, false), [{ id: 1, x: 6, z: 2 }]);
    expect(r.events.some((e) => e.kind === 'hit')).toBe(false);
  });

  it('marks a hit after a bounce as a ricochet', () => {
    const r = simulateShot(room, { x: -4, y: 1.1, z: 7 }, [0, 3, -9], [{ id: 9, x: -4, z: -3 }]);
    const hit = r.events.find((e) => e.kind === 'hit');
    expect(hit).toBeDefined();
    expect(hit!.ricochet).toBe(true);
  });

  it('can reach a hider two benches away with a lob but not with a flat shot at the same power', () => {
    const o = { x: 0, y: 1.1, z: 6.8 };
    // the bench row at z = 6.5 blocks a low line at ball height 0.15..0.45 but a lob clears it
    const lob = simulateShot(room, o, launchVelocity(0, 0, -1, 0.7, true), []);
    expect(lob.end.z).toBeLessThan(2);
  });

  it('bounces harder off metal than cloth and rests at the end', () => {
    const metal = simulateShot(room, { x: -9, y: 1.1, z: -5 }, [0, 0, -9], []);
    expect(metal.events.some((e) => e.material === 'metal')).toBe(true);
    const bounce = metal.events.find((e) => e.material === 'metal')!;
    const after = metal.keyframes.find((k) => k.t > bounce.t + 0.05)!;
    expect(after.z).toBeGreaterThan(bounce.z - 0.2); // came back towards the thrower
    for (const s of SCENARIOS) {
      const r = run(s);
      expect(r.events[r.events.length - 1].kind === 'stop' || r.end.t > 3.99).toBe(true);
    }
  });

  it('keeps the ball inside the room and above the floor', () => {
    for (const s of SCENARIOS) {
      for (const k of run(s).keyframes) {
        expect(k.y).toBeGreaterThanOrEqual(BALL_RADIUS - 1e-6);
        expect(Math.abs(k.x)).toBeLessThan(19);
        expect(Math.abs(k.z)).toBeLessThan(14);
      }
    }
  });
});

describe('camo hit geometry', () => {
  it('tags inside the 60 degree cone and 1.6 m, never behind or beyond', () => {
    const s = { x: 0, z: 0, yaw: 0 };
    expect(tagHits(s, { x: 0, z: 1.4 })).toBe(true);
    expect(tagHits(s, { x: 0.6, z: 1.4 })).toBe(true);
    expect(tagHits(s, { x: 1.2, z: 1.0 })).toBe(false);
    expect(tagHits(s, { x: 0, z: -1 })).toBe(false);
    expect(tagHits(s, { x: 0, z: 2.5 })).toBe(false);
  });

  it('accepts a kick origin within half a metre of the seeker only', () => {
    expect(kickOriginOk({ x: 1, z: 1 }, { x: 1.3, z: 1.2 })).toBe(true);
    expect(kickOriginOk({ x: 1, z: 1 }, { x: 2, z: 1 })).toBe(false);
  });

  it('knows the forbidden zones and the speed budget', () => {
    expect(inForbiddenZone(room, { x: -15, z: 11 })).toBe(true);
    expect(inForbiddenZone(room, { x: 0, z: 0 })).toBe(false);
    expect(travelBudget(100, false)).toBeGreaterThan(0.5);
    expect(travelBudget(5000, true)).toBeLessThan(10);
  });
});
