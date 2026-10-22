import { CamoHost, type CamoUser, type HostSink } from './camo-host';
import { cairoDay, seeded } from './camo-puzzle.service';
import { encodeStrokes, decodeStrokes } from './camo-paint';

function harness() {
  let t = 10_000_000;
  const sent: Array<{ userId: string; event: string; payload: any }> = [];
  const sink: HostSink = { emit: (userId, event, payload) => void sent.push({ userId, event, payload }) };
  const ended: string[] = [];
  const host = new CamoHost({ maxMatches: 3, now: () => t, sink, onMatchEnd: (m) => void ended.push(m.puzzle ? 'puzzle' : 'match') });
  const advance = (ms: number) => {
    const end = t + ms;
    while (t < end) {
      t += 100;
      for (const m of host.matches.values()) for (const p of m.players) if (!p.isBot) p.lastInputAt = t;
      host.tick(t);
    }
  };
  return { host, sent, ended, advance, now: () => t };
}
const user = (n: number): CamoUser => ({ userId: `u${n}`, name: `P${n}`, morphId: 'potato', guest: false });
const strokes = [{ kind: 'fill' as const, x: 0, y: 0, z: 0, r: 1, rgb: 0x336699, rough: 200, hard: 255, nx: 0, ny: 0, nz: 0, seed: 0 }];
const puzzle = (host: CamoHost) => {
  const room = host.roomData('locker_room')!;
  const s = room.hideSpots[3];
  return { puzzleId: 'p1', roomId: 'locker_room', x: s.x, z: s.z, yaw: 0, pose: 'stand' as const, strokes, morphId: 'potato', creatorName: 'Maker' };
};

describe('camo puzzles', () => {
  afterEach(() => jest.clearAllTimers());

  it('the seeker starts, the hider sits painted and still, and a correct tag ends the round with the time', () => {
    const { host, advance } = harness();
    expect(host.startPuzzle(user(1), puzzle(host)).ok).toBe(true);
    const m = host.matchOf('u1')!;
    advance(4_000 + 4_000 + 2_500); // reveal, short prep, whistle
    expect(m.phase).toBe('hunt');
    const seeker = m.players.find((p) => !p.isBot)!;
    const hider = m.players.find((p) => p.isBot)!;
    expect(seeker.role).toBe('seeker');
    expect(hider.frozen).toBe(true);
    expect(hider.paint.strokes.length).toBe(1);
    advance(3_000);
    expect(Math.hypot(hider.x - m.puzzle!.x, hider.z - m.puzzle!.z)).toBeLessThan(0.01); // the bot never moves
    seeker.x = hider.x;
    seeker.z = hider.z - 0.8;
    seeker.yaw = 0; // yaw 0 faces +z, towards the hider
    expect(host.tag('u1')).toBeDefined();
    advance(300);
    expect(m.puzzle!.foundMs).not.toBeNull();
    expect(['var', 'results']).toContain(m.phase);
  });

  it('three wrong tags lose the puzzle, with no suspension in between', () => {
    const { host, advance } = harness();
    host.startPuzzle(user(1), puzzle(host));
    const m = host.matchOf('u1')!;
    advance(11_000);
    const seeker = m.players.find((p) => !p.isBot)!;
    seeker.x = -17;
    seeker.z = 12;
    for (let i = 0; i < 3; i++) {
      host.tag('u1');
      advance(1_300); // the tag cooldown
      expect(seeker.suspendedUntil).toBe(0);
    }
    expect(m.puzzle!.misses).toBe(3);
    expect(m.puzzle!.foundMs).toBeNull();
    expect(['var', 'results']).toContain(m.phase);
  });

  it('a match of one round ends after the results and reports the puzzle once', () => {
    const { host, advance, ended } = harness();
    host.startPuzzle(user(1), puzzle(host));
    advance(11_000 + 62_000 + 31_000 + 16_000);
    expect(ended).toEqual(['puzzle']);
  });

  it('a challenge creator hides alone as long as they like and a bad spot is refused', () => {
    const { host, advance } = harness();
    expect(host.startCreator(user(2), 'locker_room').ok).toBe(true);
    advance(5_000);
    const m = host.matchOf('u2')!;
    expect(m.phase).toBe('prep');
    advance(200_000); // far past the 90 s
    expect(m.phase).toBe('prep');
    const p = m.players[0];
    p.x = -15.3; // inside the referees' room
    p.z = 10.5;
    expect(host.creatorSnapshot('u2')).toBeNull();
    p.x = 0;
    p.z = 4;
    const snap = host.creatorSnapshot('u2');
    expect(snap && snap.roomId).toBe('locker_room');
  });

  it('the day key follows Cairo time and the daily generator is deterministic', () => {
    expect(cairoDay(Date.parse('2026-10-22T21:30:00Z'))).toBe('2026-10-23'); // already past midnight in Cairo (UTC+3 in summer time)
    expect(cairoDay(Date.parse('2026-10-22T10:00:00Z'))).toBe('2026-10-22');
    const a = seeded('daily:2026-10-22');
    const b = seeded('daily:2026-10-22');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(decodeStrokes(encodeStrokes(strokes))!.length).toBe(1);
  });
});
