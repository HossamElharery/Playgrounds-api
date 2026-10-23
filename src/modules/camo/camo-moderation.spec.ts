import { CamoHost, type CamoUser, type HostSink, type ModerationEvent } from './camo-host';
import { playerByUser } from './camo-rules';

function harness() {
  let t = 10_000_000;
  const sent: Array<{ userId: string; event: string; payload: any }> = [];
  const audit: ModerationEvent[] = [];
  const sink: HostSink = { emit: (userId, event, payload) => void sent.push({ userId, event, payload }) };
  const host = new CamoHost({ maxMatches: 3, now: () => t, sink, onModeration: (e) => audit.push(e) });
  const advance = (ms: number) => {
    const end = t + ms;
    while (t < end) {
      t += 100;
      // the people in these tests are awake: a real client keeps sending input
      for (const m of host.matches.values()) for (const p of m.players) if (!p.isBot) p.lastInputAt = t;
      host.tick(t);
    }
  };
  return { host, sent, audit, advance, now: () => t };
}
const user = (n: number, extra: Partial<CamoUser> = {}): CamoUser => ({ userId: `u${n}`, name: `P${n}`, morphId: 'potato', guest: false, ...extra });
const eidOf = (host: CamoHost, viewer: string, userId: string) => playerByUser(host.matchOf(viewer)!, userId)!.eid;

/** n people in one public match, already in the prep phase. */
function room(n: number, partyOf: (i: number) => string | null = () => null) {
  const h = harness();
  for (let i = 1; i <= n; i++) h.host.joinPublic({ ...user(i), partyId: partyOf(i) });
  h.advance(17_000);
  return h;
}

describe('camo room votes (section 17a)', () => {
  afterEach(() => jest.clearAllTimers());

  it('a mute needs a simple majority of the real people and at least two yes', () => {
    const { host, advance } = room(5);
    const target = eidOf(host, 'u1', 'u5');
    const r = host.voteStart('u1', target, 'mute');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    host.voteCast('u2', r.voteId, true);
    expect(host.isMuted('u5')).toBe(false); // 2 of 4 voters is not a majority
    host.voteCast('u3', r.voteId, true);
    advance(300);
    expect(host.isMuted('u5')).toBe(true);
  });

  it('an unanswered mute vote fails when the time runs out and protects the target for a while', () => {
    const { host, advance } = room(4);
    const t = eidOf(host, 'u1', 'u4');
    expect(host.voteStart('u1', t, 'mute').ok).toBe(true);
    advance(21_000);
    expect(host.isMuted('u4')).toBe(false);
    const again = host.voteStart('u2', t, 'mute');
    expect(again.ok).toBe(false);
    expect(!again.ok && again.reason).toBe('protected');
  });

  it('a party counts as one vote, so four friends cannot kick a stranger on their own', () => {
    const { host, advance, audit } = room(7, (i) => (i <= 4 ? 'squadA' : null));
    const t = eidOf(host, 'u1', 'u7');
    const r = host.voteStart('u1', t, 'kick');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const u of ['u2', 'u3', 'u4']) host.voteCast(u, r.voteId, true);
    advance(21_000);
    expect(host.matchOf('u7')).not.toBeNull(); // still in
    expect(audit.some((e) => e.type === 'vote.end' && !e.passed)).toBe(true);
  });

  it('a kick needs 60% (min 3 yes), removes the person, bars the room and is audited', () => {
    const { host, advance, audit, sent } = room(6);
    const t = eidOf(host, 'u1', 'u6');
    const r = host.voteStart('u1', t, 'kick');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    host.voteCast('u2', r.voteId, true);
    host.voteCast('u3', r.voteId, true);
    advance(300);
    expect(host.matchOf('u6')).toBeNull();
    expect(sent.some((s) => s.userId === 'u6' && s.event === 'camo.kicked')).toBe(true);
    const kick = audit.find((e) => e.type === 'kick');
    expect(kick && kick.type === 'kick' && kick.voters.sort()).toEqual(['u1', 'u2', 'u3']);
    const code = host.joinPublic(user(6));
    expect(code.ok).toBe(true); // a new public match is fine; only the old room stays closed
  });

  it('one vote per starter every three minutes, and none against yourself or a bot', () => {
    const { host } = room(5);
    const m = host.matchOf('u1')!;
    const bot = m.players.find((p) => p.isBot);
    const t = eidOf(host, 'u1', 'u5');
    expect(host.voteStart('u1', t, 'mute').ok).toBe(true);
    const second = host.voteStart('u1', eidOf(host, 'u1', 'u4'), 'mute');
    expect(!second.ok && second.reason).toBe('cooldown');
    const self = host.voteStart('u2', eidOf(host, 'u2', 'u2'), 'mute');
    expect(!self.ok && self.reason).toBe('self');
    if (bot) {
      const b = host.voteStart('u3', bot.eid, 'mute');
      expect(!b.ok && b.reason).toBe('bot');
    }
  });

  it('no votes in the last 20 s of a round, and a late kick waits for the round to end', () => {
    const { host, advance } = room(6);
    advance(30_000 + 2_000); // prep -> whistle
    advance(150_000); // 30 s left in the hunt
    const t = eidOf(host, 'u1', 'u6');
    const early = host.voteStart('u1', t, 'kick');
    expect(early.ok).toBe(true);
    if (!early.ok) return;
    host.voteCast('u2', early.voteId, true);
    host.voteCast('u3', early.voteId, true);
    advance(100);
    const m = host.matchOf('u6');
    // passed with 30 s left: applied at once
    expect(m).toBeNull();
    const h2 = room(6);
    h2.advance(30_000 + 2_000 + 165_000); // 15 s left
    const late = h2.host.voteStart('u1', eidOf(h2.host, 'u1', 'u6'), 'mute');
    expect(!late.ok && late.reason).toBe('late');
  });

  it('a private host mutes, kicks and bans with no vote, and cannot be acted on', () => {
    const { host, advance } = harness();
    host.createPrivate(user(1), { bots: 3 });
    const code = host.matchOf('u1')!.code!;
    host.joinPrivate(user(2), code);
    host.joinPrivate(user(3), code);
    const e2 = eidOf(host, 'u1', 'u2');
    const e3 = eidOf(host, 'u1', 'u3');
    expect(host.hostAct('u2', e3, 'kick')).toBe(false); // not the host
    expect(host.hostAct('u1', eidOf(host, 'u1', 'u1'), 'kick')).toBe(false);
    expect(host.hostAct('u1', e2, 'mute')).toBe(true);
    expect(host.isMuted('u2')).toBe(true);
    expect(host.hostAct('u1', e3, 'ban')).toBe(true);
    advance(200);
    expect(host.joinPrivate(user(3), code)).toMatchObject({ ok: false, reason: 'banned' });
    expect(host.voteStart('u1', e2, 'mute')).toMatchObject({ ok: false, reason: 'private' });
  });

  it('a plain kick lets the person come back with the code', () => {
    const { host } = harness();
    host.createPrivate(user(1), { bots: 2 });
    const code = host.matchOf('u1')!.code!;
    host.joinPrivate(user(2), code);
    host.hostAct('u1', eidOf(host, 'u1', 'u2'), 'kick');
    expect(host.joinPrivate(user(2), code).ok).toBe(true);
  });
});
