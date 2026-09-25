import { LobbyWorldGateway, SNAPSHOT_DB_CHECK_MS } from './lobby-world.gateway';
import { LobbyWorldService } from './lobby-world.service';

type Sent = { via: string; room?: string; event: string; payload: any };

function setup(
  opts: { enabled?: boolean; rooms?: string[]; member?: boolean } = {},
) {
  const config: any = {
    get: (k: string) =>
      k === 'LOBBY_MOVEMENT_ENABLED' && opts.enabled !== false
        ? 'true'
        : undefined,
  };
  const prisma: any = {
    squadMember: {
      findUnique: jest.fn(async () =>
        opts.member === false ? null : { id: 'm' },
      ),
    },
  };
  const world = new LobbyWorldService();
  const gateway = new LobbyWorldGateway(config, prisma, world);
  const sent: Sent[] = [];
  const serverTo = jest.fn();
  gateway.server = { to: serverTo } as any;
  const client: any = {
    id: 'sock-a',
    data: { userId: 'a' },
    rooms: new Set(opts.rooms ?? ['sock-a', 'user:a', 'squad:s1']),
    to: (room: string) => ({
      emit: (event: string, payload: any) =>
        sent.push({ via: 'to', room, event, payload }),
      volatile: {
        emit: (event: string, payload: any) =>
          sent.push({ via: 'to.volatile', room, event, payload }),
      },
    }),
    emit: (event: string, payload: any) =>
      sent.push({ via: 'self', event, payload }),
  };
  return { gateway, world, client, sent, prisma, serverTo };
}

const moving = (over: Record<string, unknown> = {}) => ({
  squadId: 's1',
  seq: 1,
  x: 1,
  z: 1,
  vx: 2,
  vz: 0,
  h: 0.4,
  m: 1,
  ...over,
});

describe('LobbyWorldGateway', () => {
  describe('lobby.move', () => {
    it('ignores everything while LOBBY_MOVEMENT_ENABLED is off', () => {
      const { gateway, client, sent, world } = setup({ enabled: false });
      gateway.move(client, moving());
      expect(sent).toEqual([]);
      expect(world.snapshot('s1', 0).members).toEqual([]);
      world.onModuleDestroy();
    });

    it('ignores a socket that is not in the squad room (non-member, left, kicked)', () => {
      const { gateway, client, sent, world } = setup({
        rooms: ['sock-a', 'user:a'],
      });
      gateway.move(client, moving());
      expect(sent).toEqual([]);
      expect(world.snapshot('s1', 0).members).toEqual([]);
      world.onModuleDestroy();
    });

    it('ignores unauthenticated sockets and malformed payloads', () => {
      const { gateway, client, sent, world } = setup();
      gateway.move({ ...client, data: {} }, moving());
      gateway.move(client, moving({ x: NaN }));
      gateway.move(client, { squadId: 's1' });
      expect(sent).toEqual([]);
      world.onModuleDestroy();
    });

    it('relays in-motion updates volatile to the room, excluding the sender', () => {
      const { gateway, client, sent, serverTo, world } = setup();
      gateway.move(client, moving());
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        via: 'to.volatile',
        room: 'squad:s1',
        event: 'lobby.moved',
        payload: expect.objectContaining({
          type: 'lobby.moved',
          userId: 'a',
          x: 1,
          z: 1,
          m: 1,
          st: expect.any(Number),
        }),
      });
      // client.to(room) never includes the sender; server.to(room) would.
      expect(serverTo).not.toHaveBeenCalled();
      world.onModuleDestroy();
    });

    it('sends the stop message non-volatile', () => {
      const { gateway, client, sent, world } = setup();
      gateway.move(client, moving({ m: 0, vx: 0 }));
      expect(sent[0].via).toBe('to');
      world.onModuleDestroy();
    });

    it('corrects a teleport: relays the clamped position reliably and tells only the sender', () => {
      const { gateway, client, sent, world } = setup();
      gateway.move(client, moving({ seq: 1, x: -7, z: 0 }));
      gateway.move(client, moving({ seq: 2, x: 7, z: 0 }));
      const relay = sent[1];
      const correct = sent[2];
      expect(relay.via).toBe('to');
      expect(correct).toEqual({
        via: 'self',
        event: 'lobby.move.correct',
        payload: {
          type: 'lobby.move.correct',
          squadId: 's1',
          x: relay.payload.x,
          z: relay.payload.z,
        },
      });
      expect(relay.payload.x).toBeLessThan(7);
      world.onModuleDestroy();
    });

    it('is synchronous and never touches the database (no voice-chain ordering)', () => {
      const { gateway, client, prisma, world } = setup();
      const ret = gateway.move(client, moving());
      expect(ret).toBeUndefined();
      expect(prisma.squadMember.findUnique).not.toHaveBeenCalled();
      expect(client.data.signalChain).toBeUndefined();
      world.onModuleDestroy();
    });
  });

  describe('lobby.snapshot.request', () => {
    it('answers the requester only, from memory, when the socket is in the room', async () => {
      const { gateway, client, sent, prisma, world } = setup();
      world.acceptMove(
        { squadId: 's1', seq: 1, x: 2, z: 3, vx: 0, vz: 0, h: 1, m: 0 },
        'b',
        'sock-b',
        Date.now(),
      );
      await gateway.snapshotRequest(client, { squadId: 's1' });
      expect(sent).toEqual([
        {
          via: 'self',
          event: 'lobby.snapshot',
          payload: {
            type: 'lobby.snapshot',
            squadId: 's1',
            st: expect.any(Number),
            members: [{ userId: 'b', x: 2, z: 3, h: 1, m: 0, vx: 0, vz: 0 }],
          },
        },
      ]);
      expect(prisma.squadMember.findUnique).not.toHaveBeenCalled();
      world.onModuleDestroy();
    });

    it('falls back to one DB membership check when the request overtakes squad.lobby.join', async () => {
      jest.useFakeTimers({ now: new Date('2026-09-25T10:00:00Z') });
      try {
        const { gateway, client, sent, prisma } = setup({ rooms: ['sock-a'] });
        await gateway.snapshotRequest(client, { squadId: 's1' });
        expect(prisma.squadMember.findUnique).toHaveBeenCalledTimes(1);
        expect(sent.map((s) => s.event)).toEqual(['lobby.snapshot']);
        // A second request within 1 s is not allowed another lookup.
        await gateway.snapshotRequest(client, { squadId: 's1' });
        expect(prisma.squadMember.findUnique).toHaveBeenCalledTimes(1);
        jest.setSystemTime(Date.now() + SNAPSHOT_DB_CHECK_MS);
        await gateway.snapshotRequest(client, { squadId: 's1' });
        expect(prisma.squadMember.findUnique).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('never answers a non-member, nor while the flag is off', async () => {
      const a = setup({ rooms: ['sock-a'], member: false });
      await a.gateway.snapshotRequest(a.client, { squadId: 's1' });
      expect(a.sent).toEqual([]);
      const b = setup({ enabled: false });
      await b.gateway.snapshotRequest(b.client, { squadId: 's1' });
      expect(b.sent).toEqual([]);
      expect(b.prisma.squadMember.findUnique).not.toHaveBeenCalled();
    });

    it('survives a database error without answering', async () => {
      const { gateway, client, sent, prisma } = setup({ rooms: ['sock-a'] });
      prisma.squadMember.findUnique.mockRejectedValueOnce(new Error('db down'));
      await expect(
        gateway.snapshotRequest(client, { squadId: 's1' }),
      ).resolves.toBeUndefined();
      expect(sent).toEqual([]);
    });
  });
});
