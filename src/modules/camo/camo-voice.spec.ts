import { channelOpen, opaqueVoice, userOfVid, voiceMapFor, VOICE_MAX_LINKS } from './camo-voice';
import { generateLockerRoom } from './camo-room-locker';
import { addPlayer, createMatch, type CamoMatch, type CamoPlayer } from './camo-rules';

function match(n: number): CamoMatch {
  const m = createMatch({ id: 'm', room: generateLockerRoom(), now: 0, seed: 1, botsAllowed: false });
  for (let i = 1; i <= n; i++) addPlayer(m, { userId: `u${i}`, name: `P${i}`, isBot: false, morphId: 'potato' }, 0);
  return m;
}
const at = (p: CamoPlayer, x: number, z: number, role: CamoPlayer['role'] = 'hider', alive = true) => Object.assign(p, { x, z, role, alive, connected: true, speakingUntil: 10_000 });

describe('camo proximity voice (server side)', () => {
  it('prep: seekers hear only seekers, hiders hear only hiders', () => {
    const m = match(4);
    m.phase = 'prep';
    const [s1, s2, h1, h2] = m.players;
    at(s1, 0, 0, 'seeker'); at(s2, 1, 0, 'seeker'); at(h1, 2, 0); at(h2, 3, 0);
    expect(voiceMapFor(m, s1, 0).peers.map((e) => e.userId)).toEqual(['u2']);
    expect(voiceMapFor(m, h1, 0).peers.map((e) => e.userId)).toEqual(['u4']);
  });

  it('hunt: gain falls with distance, silence beyond 15 m, and a silent hider is never listed', () => {
    const m = match(4);
    m.phase = 'hunt';
    const [seeker, near, far, quiet] = m.players;
    at(seeker, 0, 0, 'seeker'); at(near, 5, 0); at(far, 20, 0); at(quiet, 3, 0);
    quiet.speakingUntil = 0;
    const map = voiceMapFor(m, seeker, 0);
    expect(map.peers.map((e) => e.userId)).toEqual(['u2']);
    expect(map.peers[0].gain).toBeCloseTo(1 - 5 / 15, 3);
    expect(map.connect).toEqual(['u4', 'u2']); // nearest first, the far one is out of range
  });

  it('the stands talk to the stands; everyone in the match is heard by the stands', () => {
    const m = match(3);
    m.phase = 'hunt';
    const [h, caught, seeker] = m.players;
    at(h, 0, 0); at(caught, 30, 0, 'hider', false); at(seeker, 1, 0, 'seeker');
    expect(channelOpen('hunt', h, caught)).toBe(false);
    expect(channelOpen('hunt', caught, h)).toBe(true);
    expect(voiceMapFor(m, h, 0).peers.map((e) => e.userId)).toEqual(['u3']);
    expect(voiceMapFor(m, caught, 0).peers.map((e) => e.userId).sort()).toEqual(['u1', 'u3']);
  });

  it('waiting and VAR are one open channel with no positions', () => {
    const m = match(3);
    for (const phase of ['waiting', 'var', 'results'] as const) {
      m.phase = phase;
      m.players.forEach((p, i) => at(p, i * 40, 0));
      const peers = voiceMapFor(m, m.players[0], 0).peers;
      expect(peers.length).toBe(2);
      expect(peers.every((e) => e.gain === 1 && e.x === undefined)).toBe(true);
    }
  });

  it('muted people (the room, or for me only) are never heard and never connected', () => {
    const m = match(3);
    m.phase = 'hunt';
    m.players.forEach((p, i) => at(p, i, 0, 'hider'));
    m.mod.muted.add('u2');
    m.players[0].localMuted.add(m.players[2].eid);
    const map = voiceMapFor(m, m.players[0], 0);
    expect(map.peers).toEqual([]);
    expect(map.connect).toEqual([]);
  });

  it('keeps at most five links', () => {
    const m = match(10);
    m.phase = 'waiting';
    m.players.forEach((p, i) => at(p, i, 0));
    expect(voiceMapFor(m, m.players[0], 0).connect.length).toBe(VOICE_MAX_LINKS);
  });
});

describe('opaque voice ids (section 8: a link must not name who is behind a hider)', () => {
  it('a voice message never contains a stranger\'s user id, only vids that resolve back on the server', () => {
    const m = match(4);
    m.phase = 'hunt';
    const [seeker, a, b, c] = m.players;
    at(seeker, 0, 0, 'seeker'); at(a, 4, 0); at(b, 6, 0); at(c, 8, 0);
    const msg = opaqueVoice(m, seeker, voiceMapFor(m, seeker, 0));
    const wire = JSON.stringify(msg);
    for (const p of m.players) expect(wire).not.toContain(p.userId as string);
    expect(msg.me).toBe(seeker.vid);
    expect(msg.peers.map((e) => e[0]).sort()).toEqual([a.vid, b.vid, c.vid].sort());
    expect(msg.connect).toEqual([a.vid, b.vid, c.vid]);
    expect(msg.alias).toEqual({});
    expect(userOfVid(m, a.vid)).toBe('u2');
  });

  it('vids are random per player and per match, and are never user ids or entity ids', () => {
    const m1 = match(3);
    const m2 = match(3);
    const all = [...m1.players, ...m2.players].map((p) => p.vid);
    expect(new Set(all).size).toBe(6);
    for (const p of m1.players) expect(p.vid).toMatch(/^[0-9a-f]{16}$/);
    expect(m1.players.map((p) => p.vid)).not.toContain(m1.players[0].eid);
  });

  it('party mates (and only they) are told the real id behind a vid, so their squad call is reused', () => {
    const m = match(4);
    m.phase = 'hunt';
    const [me, mate, stranger] = m.players;
    me.partyId = 'p1'; mate.partyId = 'p1';
    at(me, 0, 0, 'seeker'); at(mate, 3, 0); at(stranger, 5, 0);
    const msg = opaqueVoice(m, me, voiceMapFor(m, me, 0));
    expect(msg.alias).toEqual({ [mate.vid]: 'u2' });
    expect(Object.values(msg.alias)).not.toContain('u3');
    // the stranger's view of the same room knows nothing about the party
    expect(opaqueVoice(m, stranger, voiceMapFor(m, stranger, 0)).alias).toEqual({});
  });

  it('an unknown vid, a bot or a stale one resolves to nobody', () => {
    const m = match(2);
    addPlayer(m, { userId: null, name: 'Bot', isBot: true, morphId: 'potato' }, 0);
    expect(userOfVid(m, 'nope')).toBeNull();
    expect(userOfVid(m, m.players[2].vid)).toBeNull();
    expect(userOfVid(m, m.players[0].userId as string)).toBeNull(); // a real user id is not a vid
  });
});
