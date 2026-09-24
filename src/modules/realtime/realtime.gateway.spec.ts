import { RealtimeGateway } from './realtime.gateway';

describe('RealtimeGateway voice relay ordering', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function setup(lookupMs: (call: number) => number) {
    let call = 0;
    const prisma: any = {
      squadMember: {
        findUnique: jest.fn(async () => {
          await delay(lookupMs(call++));
          return { id: 'm' };
        }),
      },
    };
    const gateway = new RealtimeGateway({} as any, {} as any, prisma, {} as any);
    const sent: string[] = [];
    gateway.server = {
      to: () => ({ emit: (type: string) => sent.push(type) }),
    } as any;
    const client: any = { data: { userId: 'a' } };
    return { gateway, client, sent };
  }

  it('relays an ICE candidate only after the offer it belongs to', async () => {
    // The offer does two slow membership lookups, the candidate one fast one.
    // Unordered, the candidate reached the peer first and was dropped.
    const { gateway, client, sent } = setup((n) => (n < 2 ? 30 : 0));
    const offer = gateway.voiceOffer(client, { squadId: 's', toUserId: 'b', sdp: {} });
    const ice = gateway.voiceIce(client, { squadId: 's', toUserId: 'b', candidate: {} });
    await Promise.all([offer, ice]);
    expect(sent).toEqual(['voice.offer', 'voice.ice']);
  });

  it('keeps relaying after one message fails', async () => {
    const { gateway, client, sent } = setup(() => 0);
    const prisma = (gateway as any).prisma;
    prisma.squadMember.findUnique.mockRejectedValueOnce(new Error('db down'));
    await gateway.voiceIce(client, { squadId: 's', toUserId: 'b', candidate: {} });
    await gateway.voiceIce(client, { squadId: 's', toUserId: 'b', candidate: {} });
    expect(sent).toEqual(['voice.ice']);
  });

  it('ignores a candidate with no recipient', async () => {
    const { gateway, client, sent } = setup(() => 0);
    await gateway.voiceIce(client, { squadId: 's', toUserId: '', candidate: {} });
    expect(sent).toEqual([]);
  });
});

describe('RealtimeGateway lobby morph emote', () => {
  function setup(opts: { member?: boolean; enabled?: boolean } = {}) {
    const prisma: any = {
      squadMember: {
        findUnique: jest.fn(async () => (opts.member === false ? null : { id: 'm' })),
      },
    };
    const config: any = {
      get: (k: string) =>
        k === 'LOBBY_MORPHS_ENABLED' && opts.enabled !== false ? 'true' : undefined,
    };
    const gateway = new RealtimeGateway({} as any, config, prisma, {} as any);
    const sent: { room: string; type: string; payload: any }[] = [];
    gateway.server = {
      to: (room: string) => ({
        emit: (type: string, payload: any) => sent.push({ room, type, payload }),
      }),
    } as any;
    const client: any = { data: { userId: 'a' } };
    return { gateway, client, sent, prisma };
  }

  afterEach(() => jest.useRealTimers());

  it('relays an emote to the squad room for a member', async () => {
    const { gateway, client, sent } = setup();
    await gateway.memberEmote(client, { squadId: 's1' });
    expect(sent).toEqual([
      {
        room: 'squad:s1',
        type: 'squad.member.emote',
        payload: { type: 'squad.member.emote', squadId: 's1', userId: 'a', at: expect.any(String) },
      },
    ]);
    gateway.onModuleDestroy();
  });

  it('ignores a non-member and does not burn their cooldown', async () => {
    const { gateway, client, sent, prisma } = setup({ member: false });
    await gateway.memberEmote(client, { squadId: 's1' });
    expect(sent).toEqual([]);
    prisma.squadMember.findUnique.mockResolvedValueOnce({ id: 'm' });
    await gateway.memberEmote(client, { squadId: 's1' });
    expect(sent).toHaveLength(1);
    gateway.onModuleDestroy();
  });

  it('enforces a 3 s per-user cooldown across sockets', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-24T10:00:00Z') });
    const { gateway, client, sent } = setup();
    const otherTab: any = { data: { userId: 'a' } };
    await gateway.memberEmote(client, { squadId: 's1' });
    await gateway.memberEmote(otherTab, { squadId: 's1' });
    jest.setSystemTime(new Date('2026-09-24T10:00:02.900Z'));
    await gateway.memberEmote(client, { squadId: 's1' });
    expect(sent).toHaveLength(1);
    jest.setSystemTime(new Date('2026-09-24T10:00:03.000Z'));
    await gateway.memberEmote(client, { squadId: 's1' });
    expect(sent).toHaveLength(2);
    gateway.onModuleDestroy();
  });

  it('does nothing while the feature flag is off', async () => {
    const { gateway, client, sent, prisma } = setup({ enabled: false });
    await gateway.memberEmote(client, { squadId: 's1' });
    expect(sent).toEqual([]);
    expect(prisma.squadMember.findUnique).not.toHaveBeenCalled();
  });

  it('prunes stale cooldown entries with an unref’d timer', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-24T10:00:00Z') });
    const { gateway, client } = setup();
    await gateway.memberEmote(client, { squadId: 's1' });
    const map = (gateway as any).lastEmoteAt as Map<string, number>;
    expect(map.size).toBe(1);
    jest.advanceTimersByTime(60_000);
    expect(map.size).toBe(0);
    expect((gateway as any).emotePruneTimer).toBeNull();
  });
});
