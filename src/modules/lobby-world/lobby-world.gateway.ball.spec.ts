import { Subject } from 'rxjs';
import type { MorphsService } from '../morphs/morphs.service';
import type { SquadService } from '../squad/squad.service';
import { LobbyWorldGateway } from './lobby-world.gateway';
import { LobbyWorldModule } from './lobby-world.module';
import { LobbyWorldService } from './lobby-world.service';

type Sent = { via: string; room?: string; event: string; payload: any };

function setup(
  flags: Record<string, string> = {
    LOBBY_MOVEMENT_ENABLED: 'true',
    LOBBY_BALL_ENABLED: 'true',
  },
  opts: { rooms?: string[]; equipped?: string | null } = {},
) {
  const config: any = { get: (k: string) => flags[k] };
  const prisma: any = {
    squadMember: { findUnique: jest.fn(async () => ({ id: 'm' })) },
    userMorphProfile: {
      findUnique: jest.fn(async () =>
        opts.equipped === null
          ? null
          : { equippedMorphId: opts.equipped ?? 'keeper' },
      ),
    },
  };
  const world = new LobbyWorldService();
  const gateway = new LobbyWorldGateway(config, prisma, world);
  const sent: Sent[] = [];
  const roomEmitter = (room: string) => ({
    emit: (event: string, payload: any) =>
      sent.push({ via: 'server', room, event, payload }),
    volatile: {
      emit: (event: string, payload: any) =>
        sent.push({ via: 'server.volatile', room, event, payload }),
    },
  });
  gateway.server = { to: jest.fn(roomEmitter) } as any;
  gateway.afterInit();
  const client: any = {
    id: 'sock-a',
    data: { userId: 'a' },
    rooms: new Set(opts.rooms ?? ['sock-a', 'user:a', 'squad:s1']),
    to: roomEmitter,
    emit: (event: string, payload: any) =>
      sent.push({ via: 'self', event, payload }),
  };
  const standAt = (x: number, z: number) =>
    gateway.move(client, {
      squadId: 's1',
      seq: Date.now(),
      x,
      z,
      vx: 0,
      vz: 0,
      h: 0,
      m: 0,
    });
  const kickMsg = (over: Record<string, unknown> = {}) => ({
    squadId: 's1',
    seq: 1,
    dirX: 0,
    dirZ: -1,
    power: 0.4,
    px: 0,
    pz: 0.5,
    ...over,
  });
  return { gateway, world, client, sent, prisma, standAt, kickMsg };
}

describe('LobbyWorldGateway — ball', () => {
  afterEach(() => jest.useRealTimers());

  it('with LOBBY_BALL_ENABLED off, snapshots carry no ball and kicks are ignored', async () => {
    const { gateway, world, client, sent, standAt, kickMsg } = setup({
      LOBBY_MOVEMENT_ENABLED: 'true',
    });
    await gateway.snapshotRequest(client, { squadId: 's1' });
    expect(sent.at(-1)?.payload.ball).toBeUndefined();
    standAt(0, 0.5);
    const spy = jest.spyOn(world, 'kick');
    gateway.kick(client, kickMsg());
    expect(spy).not.toHaveBeenCalled();
    expect(world.hasBall('s1')).toBe(false);
    world.onModuleDestroy();
  });

  it('LOBBY_BALL_ENABLED alone does nothing (it needs movement)', async () => {
    const { gateway, world, client, sent } = setup({
      LOBBY_BALL_ENABLED: 'true',
    });
    await gateway.snapshotRequest(client, { squadId: 's1' });
    expect(sent).toHaveLength(0);
    world.onModuleDestroy();
  });

  it('the join snapshot creates the ball and carries it with the score', async () => {
    const { gateway, world, client, sent } = setup();
    await gateway.snapshotRequest(client, { squadId: 's1' });
    const snap = sent.find((s) => s.event === 'lobby.snapshot')!;
    expect(snap.via).toBe('self');
    expect(snap.payload.ball).toEqual(
      expect.objectContaining({ x: 0, z: 0, moving: false }),
    );
    expect(snap.payload.score).toEqual({ total: 0, byUser: {} });
    world.onModuleDestroy();
  });

  it('a valid kick from a room member goes to the room, non-volatile, kicker included', async () => {
    const { gateway, world, client, sent, standAt, kickMsg } = setup();
    await gateway.snapshotRequest(client, { squadId: 's1' });
    standAt(0, 0.5);
    sent.length = 0;
    gateway.kick(client, kickMsg({ seq: 7 }));
    expect(sent).toEqual([
      expect.objectContaining({
        via: 'server',
        room: 'squad:s1',
        event: 'lobby.ball.state',
      }),
    ]);
    expect(sent[0].payload).toEqual(
      expect.objectContaining({ k: 'a', s: 7, m: 1 }),
    );
    world.onModuleDestroy();
  });

  it('ignores kicks from sockets outside the squad room, guests without a user, and junk', async () => {
    const outsider = setup(undefined, { rooms: ['sock-a', 'user:a'] });
    const spy = jest.spyOn(outsider.world, 'kick');
    outsider.gateway.kick(outsider.client, outsider.kickMsg());
    expect(spy).not.toHaveBeenCalled();
    outsider.world.onModuleDestroy();

    const { gateway, world, client, kickMsg } = setup();
    const kick = jest.spyOn(world, 'kick');
    for (const bad of [
      null,
      'kick',
      kickMsg({ dirX: 0, dirZ: 0 }),
      kickMsg({ power: Infinity }),
      kickMsg({ squadId: 42 }),
    ])
      gateway.kick(client, bad);
    client.data = {};
    gateway.kick(client, kickMsg());
    expect(kick).not.toHaveBeenCalled();
    world.onModuleDestroy();
  });

  it('never trusts the client position: a far kicker claiming px/pz at the ball is refused', async () => {
    const { gateway, world, client, sent, standAt, kickMsg } = setup();
    await gateway.snapshotRequest(client, { squadId: 's1' });
    standAt(4, 4);
    sent.length = 0;
    gateway.kick(client, kickMsg({ px: 0, pz: 0.2 }));
    expect(sent).toHaveLength(0);
    world.onModuleDestroy();
  });

  it('ball ticks broadcast through the gateway (volatile while moving)', async () => {
    jest.useFakeTimers();
    const { gateway, world, client, sent, standAt, kickMsg } = setup();
    await gateway.snapshotRequest(client, { squadId: 's1' });
    standAt(0, 0.5);
    gateway.kick(client, kickMsg());
    jest.advanceTimersByTime(200);
    expect(
      sent.some(
        (s) => s.via === 'server.volatile' && s.event === 'lobby.ball.state',
      ),
    ).toBe(true);
    gateway.onModuleDestroy();
    world.onModuleDestroy();
  });

  describe('keeper morph lookup', () => {
    it('reads the equipped morph once per user, only with Lobby Morphs on', async () => {
      const on = setup({
        LOBBY_MOVEMENT_ENABLED: 'true',
        LOBBY_BALL_ENABLED: 'true',
        LOBBY_MORPHS_ENABLED: 'true',
      });
      await on.gateway.snapshotRequest(on.client, { squadId: 's1' });
      await on.gateway.snapshotRequest(on.client, { squadId: 's1' });
      expect(on.prisma.userMorphProfile.findUnique).toHaveBeenCalledTimes(1);
      expect(on.world.hasMorph('a')).toBe(true);
      on.world.onModuleDestroy();

      const off = setup();
      await off.gateway.snapshotRequest(off.client, { squadId: 's1' });
      expect(off.prisma.userMorphProfile.findUnique).not.toHaveBeenCalled();
      expect(off.world.hasMorph('a')).toBe(false);
      off.world.onModuleDestroy();
    });

    it('a failing morph read still answers the snapshot (classic radius)', async () => {
      const t = setup({
        LOBBY_MOVEMENT_ENABLED: 'true',
        LOBBY_BALL_ENABLED: 'true',
        LOBBY_MORPHS_ENABLED: 'true',
      });
      t.prisma.userMorphProfile.findUnique.mockRejectedValueOnce(
        new Error('db down'),
      );
      await t.gateway.snapshotRequest(t.client, { squadId: 's1' });
      expect(t.sent.some((s) => s.event === 'lobby.snapshot')).toBe(true);
      t.world.onModuleDestroy();
    });

    it('LobbyWorldModule forwards MorphsService.equipped$ to the world', () => {
      const world = new LobbyWorldService();
      const equipped$ = new Subject<{ userId: string; morphId: string }>();
      const mod = new LobbyWorldModule(
        { membershipEnded$: new Subject() } as unknown as SquadService,
        { equipped$ } as unknown as MorphsService,
        world,
      );
      mod.onModuleInit();
      const set = jest.spyOn(world, 'setMorph');
      equipped$.next({ userId: 'a', morphId: 'keeper' });
      expect(set).toHaveBeenCalledWith('a', 'keeper');
      mod.onModuleDestroy();
      equipped$.next({ userId: 'a', morphId: 'dino' });
      expect(set).toHaveBeenCalledTimes(1);
      world.onModuleDestroy();
    });
  });
});
