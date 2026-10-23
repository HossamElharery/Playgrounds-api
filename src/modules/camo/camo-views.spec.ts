import { addPlayer, createMatch, seekers, startRound, step, type CamoMatch } from './camo-rules';
import { sharedRoom } from './camo-sim';
import { huntBlind, paintTargets, playersFor, positionsFor, stateFor, viewerOf, visibleTo } from './camo-views';

const { room } = sharedRoom();
const NOW = 9_000_000;

function hunt(): CamoMatch {
  const m = createMatch({ id: 'v', room, seed: 4, now: NOW });
  for (let i = 0; i < 8; i++) addPlayer(m, { userId: `user-${i}`, name: `Name${i}`, isBot: false, morphId: 'potato' }, NOW);
  startRound(m, room, NOW);
  let t = NOW;
  for (let i = 0; i < 10 && m.phase !== 'hunt'; i++) {
    t = Math.max(t + 100, m.phaseEndsAt);
    step(m, room, t);
  }
  return m;
}

describe('camo views', () => {
  const m = hunt();
  const seeker = seekers(m)[0];
  const hider = m.players.find((p) => p.role === 'hider')!;

  it('a hunting seeker gets hiders without names, user ids or bot flags, and a name roster not tied to entity ids', () => {
    expect(huntBlind(m, viewerOf(seeker))).toBe(true);
    const payload = playersFor(m, viewerOf(seeker));
    const hiders = payload.players.filter((p) => p.role === 'hider');
    expect(hiders.length).toBe(m.players.filter((p) => p.role === 'hider').length);
    for (const h of hiders) {
      expect(h.name).toBeUndefined();
      expect(h.userId).toBeUndefined();
      expect(h.isBot).toBeUndefined();
    }
    const json = JSON.stringify(payload.players);
    for (const p of m.players.filter((x) => x.role === 'hider')) {
      expect(json.includes(p.userId!)).toBe(false);
      expect(json.includes(p.name)).toBe(false);
    }
    expect(payload.roster!.length).toBe(hiders.length);
    expect(Object.keys(payload.roster![0]).sort()).toEqual(['guest', 'isBot', 'name', 'userId']);
  });

  it('hiders see everybody by name, and so do spectators', () => {
    const p = playersFor(m, viewerOf(hider));
    expect(p.players.every((x) => x.name !== undefined)).toBe(true);
    expect(p.roster).toBeUndefined();
    const caught = m.players.find((x) => x.role === 'hider' && x !== hider)!;
    caught.alive = false;
    caught.caughtAt = NOW;
    expect(playersFor(m, viewerOf(caught)).players.every((x) => x.name !== undefined)).toBe(true);
    caught.alive = true;
    caught.caughtAt = null;
  });

  it('a caught hider is named to the seekers (the red card shows the name)', () => {
    const c = m.players.find((x) => x.role === 'hider' && x !== hider)!;
    c.alive = false;
    c.caughtAt = NOW;
    const view = playersFor(m, viewerOf(seeker)).players.find((x) => x.eid === c.eid)!;
    expect(view.name).toBe(c.name);
    c.alive = true;
    c.caughtAt = null;
  });

  it('positions: a seeker is told only about hiders it could see, never through lockers', () => {
    const far = m.players.filter((p) => p.role === 'hider');
    seeker.x = 0;
    seeker.z = 3;
    far.forEach((h, i) => {
      h.x = -9 + (i % 3);
      h.z = -12.1 + (i % 2) * 0.05; // against the north locker bank: behind lockers from the hall? place in front instead
    });
    // put every hider inside the closed shower corner behind walls: unseen
    far.forEach((h) => {
      h.x = 15;
      h.z = 12.6;
    });
    const tuples = positionsFor(m, room, viewerOf(seeker), NOW);
    const ids = tuples.map((t) => t[0]);
    for (const h of far) expect(ids.includes(h.eid)).toBe(false);
    expect(ids.includes(seeker.eid)).toBe(true);
    // open hall: visible
    far[0].x = 1;
    far[0].z = 4;
    expect(visibleTo(m, room, viewerOf(seeker), far[0])).toBe(true);
    expect(positionsFor(m, room, viewerOf(seeker), NOW).some((t) => t[0] === far[0].eid)).toBe(true);
  });

  it('spectators see every body; seekers get no paint before the whistle', () => {
    const spec = m.players.find((p) => p.role === 'hider')!;
    spec.alive = false;
    expect(positionsFor(m, room, viewerOf(spec), NOW).length).toBe(m.players.filter((p) => p.role !== 'spectator').length);
    spec.alive = true;
    const prepMatch = { ...m, phase: 'prep' as const };
    expect(paintTargets(prepMatch as CamoMatch, viewerOf(seeker)).length).toBe(0);
    expect(paintTargets(m, viewerOf(seeker)).length).toBeGreaterThan(0);
  });

  it('a seeker waiting in the referees room is told about no hider at all, even one standing at its door', () => {
    const prep = createMatch({ id: 'prep', room, seed: 8, now: NOW });
    for (let i = 0; i < 8; i++) addPlayer(prep, { userId: `u${i}`, name: `N${i}`, isBot: false, morphId: 'potato' }, NOW);
    startRound(prep, room, NOW);
    step(prep, room, prep.phaseEndsAt); // reveal -> prep
    expect(prep.phase).toBe('prep');
    const s = seekers(prep)[0];
    const hs = prep.players.filter((p) => p.role === 'hider');
    hs[0].x = room.refereeRoom.door.x;
    hs[0].z = room.refereeRoom.door.z; // right at the door
    hs[1].x = s.x + 0.5;
    hs[1].z = s.z; // even inside the room with it
    for (const phase of ['prep', 'whistle'] as const) {
      prep.phase = phase;
      const ids = positionsFor(prep, room, viewerOf(s), NOW).map((t) => t[0]);
      expect(ids).toEqual(prep.players.filter((p) => p.role === 'seeker').map((p) => p.eid).filter((e) => ids.includes(e)));
      for (const h of hs) expect(ids.includes(h.eid)).toBe(false);
    }
    // the hiders themselves still see each other while they prepare
    const hv = viewerOf(hs[2]);
    prep.phase = 'prep';
    hs[3].x = hs[2].x + 1;
    hs[3].z = hs[2].z;
    expect(positionsFor(prep, room, hv, NOW).some((t) => t[0] === hs[3].eid)).toBe(true);
  });

  it('state never leaks the private room code to public matches', () => {
    expect(stateFor(m, viewerOf(seeker), NOW).code).toBeNull();
    const priv = createMatch({ id: 'p', room, isPrivate: true, code: 'ABCDE', seed: 1, now: NOW });
    expect(stateFor(priv, null, NOW).code).toBe('ABCDE');
  });
});
