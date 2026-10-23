import { DISGUISE } from './camo-constants';
import { copyable, disguiseBody, distToProp } from './camo-disguise';
import { acceptDisguise, acceptKick, addPlayer, createMatch, hitBody, hidersAlive, playerById, seekers, startRound, step, type CamoMatch } from './camo-rules';
import { sharedRoom } from './camo-sim';
import { generateAhwa, generateRamadanAlley, generateFiveASide } from './camo-rooms-m2';
import { generateWarehouse } from './camo-room-warehouse';
import { generateLockerRoom } from './camo-room-locker';

const { room } = sharedRoom();
const NOW = 5_000_000;

function inPrep(): CamoMatch {
  const m = createMatch({ id: 'm', room, mode: 'classic', seed: 4, now: NOW });
  for (let i = 0; i < 6; i++) addPlayer(m, { userId: `u${i}`, name: `P${i}`, isBot: false, morphId: 'potato' }, NOW);
  startRound(m, room, NOW);
  let t = NOW;
  for (let i = 0; i < 10 && m.phase !== 'prep'; i++) {
    t = Math.max(t + 100, m.phaseEndsAt);
    step(m, room, t);
  }
  return m;
}

describe('what a hider can become', () => {
  it('copies things a person could push around, never structure or signs', () => {
    const rooms = [generateLockerRoom(), generateWarehouse(), generateFiveASide(), generateAhwa(), generateRamadanAlley()];
    for (const r of rooms) {
      const ok = r.props.filter((p) => disguiseBody(p));
      expect(ok.length).toBeGreaterThanOrEqual(40);
      for (const p of r.props) {
        if (['walls', 'ref-room', 'pillar', 'beam', 'skywindow', 'locker', 'shelf-rack', 'container'].includes(p.type)) expect(disguiseBody(p)).toBeNull();
      }
      // the same kind repeats, so a copy has neighbours to blend with
      const byType = new Map<string, number>();
      for (const p of ok) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
      expect(Math.max(...byType.values())).toBeGreaterThanOrEqual(6);
    }
  });

  it('gives the copy a hit body that matches the object, never absurdly small or tall', () => {
    for (const p of room.props) {
      const b = disguiseBody(p);
      if (!b) continue;
      expect(b.r).toBeGreaterThanOrEqual(DISGUISE.hitRadius.min);
      expect(b.r).toBeLessThanOrEqual(DISGUISE.hitRadius.max);
      expect(b.h).toBeGreaterThanOrEqual(DISGUISE.hitHeight.min);
      expect(b.h).toBeLessThanOrEqual(DISGUISE.hitHeight.max);
    }
  });

  it('only lets a living hider copy a reachable object, with a cooldown, in prep or the hunt', () => {
    const m = inPrep();
    const h = hidersAlive(m)[0];
    const near = (() => {
      for (const s of room.hideSpots) {
        const c = copyable(room, s.x, s.z);
        if (c.length) return { s, i: c[0][0] };
      }
      return null;
    })()!;
    h.x = near.s.x;
    h.z = near.s.z;
    const far = room.props.findIndex((p) => disguiseBody(p) && distToProp(p, h.x, h.z) > DISGUISE.reachM + 1);
    expect(acceptDisguise(m, room, h.eid, far, NOW + 1000).ok).toBe(false);
    expect(acceptDisguise(m, room, h.eid, 99999, NOW + 1000).ok).toBe(false);
    expect(acceptDisguise(m, room, h.eid, near.i, NOW + 1000)).toEqual({ ok: true, dg: near.i });
    expect(h.disguise).toBe(near.i);
    expect(hitBody(room, h).h).toBeLessThanOrEqual(1.7);
    // cooldown, then back to a person
    expect(acceptDisguise(m, room, h.eid, -1, NOW + 1100).ok).toBe(false);
    expect(acceptDisguise(m, room, h.eid, -1, NOW + 2000)).toEqual({ ok: true, dg: -1 });
    // a referee cannot copy anything
    const s = seekers(m)[0];
    expect(acceptDisguise(m, room, s.eid, near.i, NOW + 5000).ok).toBe(false);
    expect(playerById(m, s.eid)!.disguise).toBe(-1);
  });

  it('a shot that would have hit a standing player passes over a hider who is a small object', () => {
    const m = inPrep();
    let t = NOW;
    const h = hidersAlive(m)[0];
    const small = room.props.findIndex((p) => {
      const b = disguiseBody(p);
      return !!b && b.h < 0.7;
    });
    expect(small).toBeGreaterThanOrEqual(0);
    h.x = room.props[small].x;
    h.z = room.props[small].z + 0.3;
    expect(acceptDisguise(m, room, h.eid, small, t + 1000).ok).toBe(true);
    expect(hitBody(room, h).h).toBeLessThan(0.8);
    for (let i = 0; i < 20 && m.phase !== 'hunt'; i++) {
      t = Math.max(t + 100, m.phaseEndsAt);
      step(m, room, t);
    }
    const s = seekers(m)[0];
    s.x = h.x - 6;
    s.z = h.z;
    const before = h.alive;
    // chest-high flat shot at the hider
    acceptKick(m, room, s.eid, { origin: { x: s.x, y: 1.3, z: s.z }, dir: [1, 0, 0], power: 1, lob: false, seq: 1 }, t + 100);
    expect(before).toBe(true);
    expect(h.alive).toBe(true);
  });
});
