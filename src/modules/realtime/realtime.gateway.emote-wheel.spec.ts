import {
  LOBBY_EMOTE_IDS,
  RealtimeGateway,
  SQUAD_WHEEL_EMOTE_COOLDOWN_MS,
} from './realtime.gateway';

/** Lobby World emote wheel on top of the Lobby Morphs signature relay. */
describe('RealtimeGateway emote wheel (squad.member.emote + emoteId)', () => {
  function setup(
    opts: { movement?: boolean; morphs?: boolean; inRoom?: boolean } = {},
  ) {
    const prisma: any = {
      squadMember: { findUnique: jest.fn(async () => ({ id: 'm' })) },
    };
    const config: any = {
      get: (k: string) => {
        if (k === 'LOBBY_MOVEMENT_ENABLED')
          return opts.movement === false ? undefined : 'true';
        if (k === 'LOBBY_MORPHS_ENABLED')
          return opts.morphs === false ? undefined : 'true';
        return undefined;
      },
    };
    const gateway = new RealtimeGateway({} as any, config, prisma, {} as any);
    const sent: { room: string; type: string; payload: any }[] = [];
    gateway.server = {
      to: (room: string) => ({
        emit: (type: string, payload: any) =>
          sent.push({ room, type, payload }),
      }),
    } as any;
    const client: any = {
      data: { userId: 'a' },
      rooms: new Set(
        opts.inRoom === false ? ['user:a'] : ['user:a', 'squad:s1'],
      ),
    };
    return { gateway, client, sent, prisma };
  }

  afterEach(() => jest.useRealTimers());

  it('relays every whitelisted emoteId to the squad room', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-25T10:00:00Z') });
    const { gateway, client, sent } = setup();
    for (const emoteId of LOBBY_EMOTE_IDS) {
      await gateway.memberEmote(client, { squadId: 's1', emoteId });
      jest.setSystemTime(Date.now() + SQUAD_WHEEL_EMOTE_COOLDOWN_MS);
    }
    expect(sent.map((s) => s.payload.emoteId)).toEqual([...LOBBY_EMOTE_IDS]);
    expect(sent[0]).toEqual({
      room: 'squad:s1',
      type: 'squad.member.emote',
      payload: {
        type: 'squad.member.emote',
        squadId: 's1',
        userId: 'a',
        emoteId: 'wave',
        at: expect.any(String),
      },
    });
    gateway.onModuleDestroy();
  });

  it('drops ids outside the whitelist and non-string ids', async () => {
    const { gateway, client, sent } = setup();
    await gateway.memberEmote(client, { squadId: 's1', emoteId: 'moonwalk' });
    await gateway.memberEmote(client, { squadId: 's1', emoteId: 3 });
    await gateway.memberEmote(client, { squadId: 's1', emoteId: null });
    expect(sent).toEqual([]);
  });

  it('enforces 1.2 s between wheel emotes, separately from the 3 s signature budget', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-25T10:00:00Z') });
    const { gateway, client, sent } = setup();
    await gateway.memberEmote(client, { squadId: 's1' }); // signature
    await gateway.memberEmote(client, { squadId: 's1', emoteId: 'clap' }); // own budget: allowed
    jest.setSystemTime(new Date('2026-09-25T10:00:01.100Z'));
    await gateway.memberEmote(client, { squadId: 's1', emoteId: 'dance' }); // < 1.2 s: dropped
    jest.setSystemTime(new Date('2026-09-25T10:00:01.200Z'));
    await gateway.memberEmote(client, { squadId: 's1', emoteId: 'dance' }); // allowed
    await gateway.memberEmote(client, { squadId: 's1' }); // signature still cooling down
    expect(sent.map((s) => s.payload.emoteId ?? 'signature')).toEqual([
      'signature',
      'clap',
      'dance',
    ]);
    gateway.onModuleDestroy();
  });

  it('needs the movement flag (not the morphs flag) and ignores sockets outside the room', async () => {
    const off = setup({ movement: false });
    await off.gateway.memberEmote(off.client, {
      squadId: 's1',
      emoteId: 'wave',
    });
    expect(off.sent).toEqual([]);

    const noMorphs = setup({ morphs: false });
    await noMorphs.gateway.memberEmote(noMorphs.client, {
      squadId: 's1',
      emoteId: 'wave',
    });
    expect(noMorphs.sent).toHaveLength(1);
    noMorphs.gateway.onModuleDestroy();

    const outside = setup({ inRoom: false });
    await outside.gateway.memberEmote(outside.client, {
      squadId: 's1',
      emoteId: 'wave',
    });
    expect(outside.sent).toEqual([]);
  });

  it('stays out of the voice signaling chain and the database', async () => {
    const { gateway, client, prisma } = setup();
    await gateway.memberEmote(client, { squadId: 's1', emoteId: 'thumbs' });
    expect(prisma.squadMember.findUnique).not.toHaveBeenCalled();
    expect(client.data.signalChain).toBeUndefined();
    gateway.onModuleDestroy();
  });

  it('keeps the old signature relay unchanged for clients that send no emoteId', async () => {
    const { gateway, client, sent, prisma } = setup();
    await gateway.memberEmote(client, { squadId: 's1' });
    expect(prisma.squadMember.findUnique).toHaveBeenCalledTimes(1);
    expect(sent[0].payload).toEqual({
      type: 'squad.member.emote',
      squadId: 's1',
      userId: 'a',
      at: expect.any(String),
    });
    gateway.onModuleDestroy();
  });
});
