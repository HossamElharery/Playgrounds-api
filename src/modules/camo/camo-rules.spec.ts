import { CARD, ROUNDS_PER_MATCH, TIMERS, seekerCount } from './camo-constants';
import {
  acceptKick,
  acceptMove,
  acceptPaint,
  acceptScan,
  acceptTag,
  acceptTaunt,
  acceptWhistle,
  addPlayer,
  assignRoles,
  beginTouchUp,
  createMatch,
  hidersAlive,
  mulberry32,
  playerById,
  ranking,
  seekers,
  setFreeze,
  setPose,
  startRound,
  step,
  type CamoMatch,
} from './camo-rules';
import { sharedRoom } from './camo-sim';
import type { WireStroke } from './camo-paint';

const { room } = sharedRoom();
const NOW = 5_000_000;

function lobby(n: number, mode: 'classic' | 'contagion' = 'classic', seed = 1): CamoMatch {
  const m = createMatch({ id: 'm', room, mode, seed, now: NOW });
  for (let i = 0; i < n; i++) addPlayer(m, { userId: `u${i}`, name: `P${i}`, isBot: false, morphId: 'potato' }, NOW);
  return m;
}

/** Advances the match to a phase by jumping the clock to each deadline. */
function toPhase(m: CamoMatch, phase: string, from = NOW): number {
  let t = from;
  for (let i = 0; i < 20 && m.phase !== phase; i++) {
    t = Math.max(t + 100, m.phaseEndsAt);
    step(m, room, t);
  }
  return t;
}

const brush = (over: Partial<WireStroke> = {}): WireStroke => ({ kind: 'brush', x: 0, y: 800, z: 0, r: 40, rgb: 0x808080, rough: 100, hard: 120, nx: 0, ny: 0, nz: 0, seed: 1, ...over });

describe('camo roles and phases', () => {
  it('uses 1 seeker for 4-5 players, 2 for 6-9 and 3 for 10', () => {
    expect([4, 5, 6, 9, 10].map(seekerCount)).toEqual([1, 1, 2, 2, 3]);
    for (const n of [4, 6, 10]) {
      const m = lobby(n);
      assignRoles(m);
      expect(seekers(m).length).toBe(seekerCount(n));
    }
  });

  it('rotates the whistle: nobody is a seeker twice before everybody has been', () => {
    const m = lobby(8, 'classic', 3);
    const was = new Set<string>();
    for (let round = 0; round < 3; round++) {
      assignRoles(m);
      for (const s of seekers(m)) {
        expect(was.has(s.userId!)).toBe(false);
        was.add(s.userId!);
      }
    }
  });

  it('runs reveal -> prep -> whistle -> hunt in order with the default timers', () => {
    const m = lobby(8);
    startRound(m, room, NOW);
    expect(m.phase).toBe('reveal');
    let t = NOW;
    const seen: string[] = ['reveal'];
    for (let i = 0; i < 6; i++) {
      t = m.phaseEndsAt;
      step(m, room, t);
      if (seen[seen.length - 1] !== m.phase) seen.push(m.phase);
      if (m.phase === 'hunt') break;
    }
    expect(seen).toEqual(['reveal', 'prep', 'whistle', 'hunt']);
    expect(m.phaseEndsAt - t).toBe(TIMERS.huntMs);
  });

  it('plays three rounds and ends with a ranking where ties share a rank', () => {
    const m = lobby(8);
    startRound(m, room, NOW);
    let t = NOW;
    for (let i = 0; i < 80 && m.phase !== 'ended'; i++) {
      t = Math.max(t + 100, m.phaseEndsAt);
      step(m, room, t);
    }
    expect(m.phase).toBe('ended');
    expect(m.rounds.length).toBe(ROUNDS_PER_MATCH);
    const r = ranking(m);
    expect(r[0].rank).toBe(1);
    expect(r.filter((x) => x.total === r[0].total).every((x) => x.rank === 1)).toBe(true);
  });

  it('gives fresh entity ids every round', () => {
    const m = lobby(6);
    startRound(m, room, NOW);
    const a = m.players.map((p) => p.eid);
    toPhase(m, 'results');
    step(m, room, m.phaseEndsAt + 1);
    const b = m.players.map((p) => p.eid);
    expect(a.some((id, i) => b[i] === id)).toBe(false);
  });
});

describe('camo moves, poses and paint', () => {
  function inHunt(n = 6, mode: 'classic' | 'contagion' = 'classic') {
    const m = lobby(n, mode);
    startRound(m, room, NOW);
    const t = toPhase(m, 'hunt');
    return { m, t };
  }

  it('keeps seekers in the referees room until the whistle and freezes nobody inside it', () => {
    const m = lobby(6);
    startRound(m, room, NOW);
    toPhase(m, 'prep');
    const s = seekers(m)[0];
    expect(acceptMove(m, room, s.eid, { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, seq: 1 }, m.phaseEndsAt - 1000)).toBeNull();
    const h = m.players.find((p) => p.role === 'hider')!;
    h.x = s.x;
    h.z = s.z;
    expect(setFreeze(m, room, h.eid, true, NOW + 1)).toBe(false);
    h.x = 0;
    h.z = 0;
    expect(setFreeze(m, room, h.eid, true, NOW + 2)).toBe(true);
  });

  it('caps speed, pushes bodies out of lockers and drops replays', () => {
    const { m, t } = inHunt();
    const h = hidersAlive(m)[0];
    h.x = 0;
    h.z = 3;
    h.lastMoveAt = t;
    const far = acceptMove(m, room, h.eid, { x: 15, z: 3, yaw: 0, vx: 0, vz: 0, seq: 1 }, t + 100)!;
    expect(far.corrected).toBe(true);
    expect(far.x).toBeLessThan(4);
    expect(acceptMove(m, room, h.eid, { x: 0, z: 3, yaw: 0, vx: 0, vz: 0, seq: 1 }, t + 200)).toBeNull();
    h.x = -9;
    h.z = -10;
    h.lastMoveAt = t + 300;
    const wall = acceptMove(m, room, h.eid, { x: -9, z: -12.2, yaw: 0, vx: 0, vz: 0, seq: 5 }, t + 400)!;
    expect(wall.z).toBeGreaterThan(-12.5 + 0.2);
  });

  it('accepts paint only in prep (and one 5 s touch-up in the hunt) and enforces the limits', () => {
    const m = lobby(6);
    startRound(m, room, NOW);
    const h = m.players.find((p) => p.role === 'hider')!;
    expect(acceptPaint(m, h.eid, [brush()], NOW)).toBeNull(); // reveal
    toPhase(m, 'prep');
    expect(acceptPaint(m, h.eid, [brush(), brush({ x: 5000 })], m.phaseEndsAt - 1000)!.rejected).toBe(1);
    const t = toPhase(m, 'hunt');
    expect(acceptPaint(m, h.eid, [brush()], t)).toBeNull();
    expect(beginTouchUp(m, h.eid, t)).toBe(true);
    expect(acceptPaint(m, h.eid, [brush()], t + 1000)!.accepted.length).toBe(1);
    expect(acceptPaint(m, h.eid, [brush()], t + 6000)).toBeNull();
    expect(beginTouchUp(m, h.eid, t + 7000)).toBe(false);
    expect(setPose(m, h.eid, 'sit', t)).toBe(true);
    expect(setPose(m, h.eid, 'sujud', t)).toBe(false);
  });
});

describe('camo cards', () => {
  function hunt(contagion = false) {
    const m = lobby(6, contagion ? 'contagion' : 'classic');
    startRound(m, room, NOW);
    const t = toPhase(m, 'hunt');
    const s = seekers(m)[0];
    s.x = 0;
    s.z = 8;
    s.yaw = Math.PI; // faces -z
    s.ballReadyAt = 0;
    // the other referees stand in the referees' room looking at its wall, so only `s` takes part in a test
    for (const o of seekers(m)) if (o !== s) { o.x = -17; o.z = 12; o.yaw = 0; }
    const hs = hidersAlive(m);
    hs.forEach((h, i) => {
      h.x = -16 + i; // out of the line
      h.z = -8;
      h.frozen = true;
    });
    return { m, t, s, hs };
  }
  const shot = (s: { x: number; z: number }, dir: [number, number, number]) => ({ origin: { x: s.x, y: 1.1, z: s.z }, dir, power: 1, lob: false, seq: 1 });

  it('a ball that touches a hider is a red card, with points to the seeker and the hider out', () => {
    const { m, t, s, hs } = hunt();
    const h = hs[0];
    h.x = 0;
    h.z = 3;
    const r = acceptKick(m, room, s.eid, shot(s, [0, -0.02, -1]), t + 100)!;
    expect(r.hit).toBe(1);
    expect(h.alive).toBe(false);
    expect(m.outbox.some((e) => e.t === 'card' && e.kind === 'red' && e.target === h.eid)).toBe(true);
    expect(s.points).toBeGreaterThanOrEqual(40);
    expect(s.stats.redCards).toBe(1);
  });

  it('a miss is a yellow card that costs points; nobody is ever frozen for a miss', () => {
    const { m, t, s } = hunt();
    for (let i = 0; i < 4; i++) {
      s.ballReadyAt = 0;
      acceptKick(m, room, s.eid, shot(s, [0, 0, 1]), t + 100 + i * 5000);
    }
    expect(s.stats.yellowCards).toBe(4);
    expect(s.points).toBe(-40);
    expect(s.suspendedUntil).toBe(0);
    expect(m.outbox.some((e) => e.t === 'suspend')).toBe(false);
    // right after the fourth miss the seeker can still tag and walk (the ball itself is on its short return)
    expect(acceptTag(m, s.eid, t + 100 + 3 * 5000 + 10)).not.toBeNull();
    expect(acceptMove(m, room, s.eid, { x: s.x + 0.1, z: s.z, yaw: 0, vx: 0, vz: 0, seq: 999 }, t + 100 + 3 * 5000 + 200)).not.toBeNull();
  });

  it('aim assist turns a human shot onto a visible hider within 6 degrees, and never helps a bot', () => {
    const { m, t, s, hs } = hunt();
    s.x = -2.5;
    s.z = 9;
    hs.forEach((h, i) => { h.x = 14 + i; h.z = 12; }); // everybody far away
    const h = hs[0];
    h.x = s.x;
    h.z = s.z - 6; // straight ahead (-z) ...
    // ... but the crosshair is 5.5 degrees off to the side (a plain ball misses at 6 m)
    const a = (5.5 * Math.PI) / 180;
    const r = acceptKick(m, room, s.eid, shot(s, [Math.sin(a), 0, -Math.cos(a)]), t + 100)!;
    expect(r.hit).toBe(1);
    // the same shot from a bot misses
    const m2 = hunt();
    m2.s.x = -2.5;
    m2.s.z = 9;
    m2.hs.forEach((x, i) => { x.x = 14 + i; x.z = 12; });
    m2.hs[0].x = m2.s.x;
    m2.hs[0].z = m2.s.z - 6;
    m2.s.isBot = true;
    expect(acceptKick(m2.m, room, m2.s.eid, shot(m2.s, [Math.sin(a), 0, -Math.cos(a)]), m2.t + 100)!.hit).toBe(0);
    // 10 degrees off: no help
    const m3 = hunt();
    m3.s.x = -2.5;
    m3.s.z = 9;
    m3.hs.forEach((x, i) => { x.x = 14 + i; x.z = 12; });
    m3.hs[0].x = m3.s.x;
    m3.hs[0].z = m3.s.z - 6;
    const b = (10 * Math.PI) / 180;
    expect(acceptKick(m3.m, room, m3.s.eid, shot(m3.s, [Math.sin(b), 0, -Math.cos(b)]), m3.t + 100)!.hit).toBe(0);
  });

  it('one ball in the air per seeker: it is back 1.5 s after it stops or first hits', () => {
    const { m, t, s } = hunt();
    expect(acceptKick(m, room, s.eid, shot(s, [0, 0, 1]), t + 100)).not.toBeNull();
    expect(acceptKick(m, room, s.eid, shot(s, [0, 0, 1]), t + 150)).toBeNull();
    expect(s.ballReadyAt - (t + 100)).toBeGreaterThanOrEqual(CARD.ballReturnMs);
  });

  it('refuses a kick whose origin is not where the seeker really is', () => {
    const { m, t, s } = hunt();
    expect(acceptKick(m, room, s.eid, { origin: { x: s.x + 3, y: 1.1, z: s.z }, dir: [0, 0, -1], power: 1, lob: false, seq: 1 }, t + 100)).toBeNull();
  });

  it('the grab tags every hider in the cone, yellow when it finds nobody, with a 1 s cooldown', () => {
    const { m, t, s, hs } = hunt();
    hs[0].x = s.x;
    hs[0].z = s.z - 1.2;
    const r = acceptTag(m, s.eid, t + 100)!;
    expect(r.hit).toBe(1);
    expect(hs[0].alive).toBe(false);
    expect(acceptTag(m, s.eid, t + 600)).toBeNull();
    expect(acceptTag(m, s.eid, t + 1300)!.hit).toBe(0);
    expect(s.stats.yellowCards).toBe(1);
  });

  it('whistle gives noisy positions of hiders within 20 m, once per 45 s', () => {
    const { m, t, s, hs } = hunt();
    hs[0].x = s.x;
    hs[0].z = s.z - 8;
    expect(acceptWhistle(m, s.eid, t + 100)).toBe(true);
    const noise = m.outbox.find((e) => e.t === 'whistle.noise');
    expect(noise && noise.t === 'whistle.noise' && noise.positions.some((p) => p.eid === hs[0].eid)).toBe(true);
    expect(acceptWhistle(m, s.eid, t + 5000)).toBe(false);
    expect(acceptWhistle(m, s.eid, t + 46_000)).toBe(true);
  });

  it('the scan only lights hiders that move inside 10 m', () => {
    const { m, t, s, hs } = hunt();
    hs[0].x = s.x;
    hs[0].z = s.z - 5;
    hs[0].frozen = false;
    hs[0].vx = 1;
    hs[1].x = s.x + 2;
    hs[1].z = s.z - 5;
    hs[1].frozen = true;
    expect(acceptScan(m, s.eid, t + 100)).toBe(true);
    const e = m.outbox.find((x) => x.t === 'scan');
    expect(e && e.t === 'scan' && e.flashed).toEqual([hs[0].eid]);
    expect(acceptScan(m, s.eid, t + 5000)).toBe(false);
  });

  it('a taunt has a 20 s cooldown and counts', () => {
    const { m, t, hs } = hunt();
    expect(acceptTaunt(m, hs[0].eid, t + 100)).toBe(true);
    expect(acceptTaunt(m, hs[0].eid, t + 5000)).toBe(false);
    expect(hs[0].stats.tauntCount).toBe(1);
  });

  it('contagion: a caught hider becomes a seeker and the round ends when none is left', () => {
    const { m, t, s, hs } = hunt(true);
    hs.forEach((h) => {
      h.x = s.x;
      h.z = s.z - 1.0;
    });
    const r = acceptTag(m, s.eid, t + 100)!;
    expect(r.hit).toBe(hs.length);
    expect(hs.every((h) => h.role === 'seeker')).toBe(true);
    step(m, room, t + 200);
    expect(m.phase).toBe('var');
    expect(m.rounds[0].winner).toBe('seekers');
  });

  it('stoppage time: +30 s once when the last hider was seen in the last 10 s', () => {
    const { m, t, s, hs } = hunt();
    for (const h of hs.slice(1)) h.alive = false;
    hs[0].x = s.x;
    hs[0].z = s.z - 4;
    hs[0].lastSeenAt = m.phaseEndsAt - 3000;
    step(m, room, m.phaseEndsAt + 10);
    expect(m.stoppageUsed).toBe(true);
    expect(m.phase).toBe('hunt');
    const end = m.phaseEndsAt;
    step(m, room, end + 10);
    expect(m.phase).toBe('var');
    void t;
  });

  it('awards: golden chameleon to the best surviving camo, eagle eye to the most red cards', () => {
    const { m, t, s, hs } = hunt();
    hs[0].stats.camo = 0.9;
    hs[1].stats.camo = 0.4;
    hs[0].x = 0;
    hs[0].z = 3;
    s.stats.redCards = 0;
    acceptKick(m, room, s.eid, shot(s, [0, -0.02, -1]), t + 100);
    for (const h of hs.slice(2)) h.alive = false;
    hs.slice(2).forEach((h) => (h.caughtAt = t + 200));
    step(m, room, m.phaseEndsAt + 100_000);
    const awards = m.rounds[0].awards.map((a) => a.award);
    expect(awards).toContain('golden_chameleon');
    expect(awards).toContain('eagle_eye');
    const gold = m.rounds[0].awards.find((a) => a.award === 'golden_chameleon')!;
    // the 0.9 hider was shot: the best camo among the SURVIVORS wins
    expect(playerById(m, gold.eid)?.stats.camo).toBe(0.4);
  });

  it('a seeded rng replays the same roles', () => {
    const a = lobby(8, 'classic', 77);
    const b = lobby(8, 'classic', 77);
    assignRoles(a);
    assignRoles(b);
    expect(a.players.map((p) => p.role)).toEqual(b.players.map((p) => p.role));
    expect(mulberry32(5)()).toBe(mulberry32(5)());
  });
});
