import { RealtimeGateway } from './realtime.gateway';
import { VoiceScopeRegistry } from './voice-scope.registry';

/** The relay between strangers in a camo match: a sender and a receiver only ever see vids. */
describe('voice relay with opaque scope names', () => {
  const vids: Record<string, string> = { u1: 'v-one', u2: 'v-two', u3: 'v-three' };
  const users = Object.fromEntries(Object.entries(vids).map(([u, v]) => [v, u]));

  function setup() {
    const registry = new VoiceScopeRegistry();
    registry.register(
      'camo',
      (id, userId) => id === 'm1' && userId in vids,
      {
        toUser: (id, _viewer, key) => (id === 'm1' ? (users[key] ?? null) : null),
        toKey: (id, userId) => (id === 'm1' ? (vids[userId] ?? null) : null),
      },
    );
    const gw = new RealtimeGateway({} as never, {} as never, {} as never, {} as never, registry);
    const sent: Array<{ to: string; event: Record<string, unknown> }> = [];
    (gw as unknown as { emitToUser: unknown }).emitToUser = (to: string, event: Record<string, unknown>) => sent.push({ to, event });
    const client = (id: string) => ({ data: { userId: id }, rooms: new Set() }) as never;
    return { gw, sent, client };
  }

  it('offer/answer/ice/hangup: the receiver sees the sender\'s vid and the target is resolved from a vid', async () => {
    const { gw, sent, client } = setup();
    await gw.voiceOffer(client('u1'), { squadId: 'camo:m1', toUserId: 'v-two', sdp: 'x' });
    await gw.voiceAnswer(client('u2'), { squadId: 'camo:m1', toUserId: 'v-one', sdp: 'y' });
    await gw.voiceIce(client('u1'), { squadId: 'camo:m1', toUserId: 'v-two', candidate: { c: 1 } });
    await gw.voiceHangup(client('u2'), { squadId: 'camo:m1', toUserId: 'v-one' });
    expect(sent.map((s) => [s.to, s.event.type, s.event.fromUserId])).toEqual([
      ['u2', 'voice.offer', 'v-one'],
      ['u1', 'voice.answer', 'v-two'],
      ['u2', 'voice.ice', 'v-one'],
      ['u1', 'voice.hangup', 'v-two'],
    ]);
  });

  it('no message in either direction contains a user id', async () => {
    const { gw, sent, client } = setup();
    await gw.voiceOffer(client('u1'), { squadId: 'camo:m1', toUserId: 'v-two', sdp: 'x' });
    await gw.voiceIce(client('u2'), { squadId: 'camo:m1', toUserId: 'v-one', candidate: {} });
    for (const s of sent) expect(JSON.stringify(s.event)).not.toMatch(/"u[123]"/);
  });

  it('addressing by a real user id (instead of a vid) goes nowhere', async () => {
    const { gw, sent, client } = setup();
    await gw.voiceOffer(client('u1'), { squadId: 'camo:m1', toUserId: 'u2', sdp: 'x' });
    await gw.voiceIce(client('u1'), { squadId: 'camo:m1', toUserId: 'u2', candidate: {} });
    expect(sent).toEqual([]);
  });

  it('a stranger outside the match cannot relay into it', async () => {
    const { gw, sent, client } = setup();
    await gw.voiceOffer(client('outsider'), { squadId: 'camo:m1', toUserId: 'v-two', sdp: 'x' });
    expect(sent).toEqual([]);
  });

  it('a plain squad id keeps working with user ids', async () => {
    const registry = new VoiceScopeRegistry();
    const prisma = { squadMember: { findUnique: async () => ({ id: 1 }) } };
    const gw = new RealtimeGateway({} as never, {} as never, prisma as never, {} as never, registry);
    const sent: Array<{ to: string; event: Record<string, unknown> }> = [];
    (gw as unknown as { emitToUser: unknown }).emitToUser = (to: string, event: Record<string, unknown>) => sent.push({ to, event });
    await gw.voiceOffer({ data: { userId: 'a' }, rooms: new Set() } as never, { squadId: 'squad9', toUserId: 'b', sdp: 's' });
    expect(sent).toEqual([{ to: 'b', event: { type: 'voice.offer', squadId: 'squad9', fromUserId: 'a', sdp: 's' } }]);
  });
});
