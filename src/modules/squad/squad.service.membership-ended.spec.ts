import { SquadService, type SquadMembershipEnded } from './squad.service';
import { LobbyWorldModule } from '../lobby-world/lobby-world.module';
import { LobbyWorldService } from '../lobby-world/lobby-world.service';

/** Lobby World positions die with the membership: leave, kick, and the emptied squad. */
describe('SquadService membershipEnded$', () => {
  function setup(opts: { remaining?: number; isLeader?: boolean } = {}) {
    const prisma: any = {
      squadMember: {
        findUnique: jest.fn(async () => ({
          id: 'row-1',
          squadId: 's1',
          userId: 'u2',
          isLeader: opts.isLeader ?? false,
        })),
        findFirst: jest.fn(async () => null),
        update: jest.fn(async () => ({})),
        delete: jest.fn(async () => ({})),
        count: jest.fn(async () => opts.remaining ?? 1),
      },
      squadInvite: { updateMany: jest.fn(async () => ({ count: 0 })) },
      squad: { delete: jest.fn(async () => ({})) },
    };
    const presence: any = {
      setInSquad: jest.fn(),
      setSquadConnected: jest.fn(),
    };
    const emitter: any = { emitToRoom: jest.fn(), revokeRoomAccess: jest.fn() };
    const service = new SquadService(
      prisma,
      presence,
      emitter,
      {} as any,
      { get: () => undefined } as any,
    );
    const ended: SquadMembershipEnded[] = [];
    service.membershipEnded$.subscribe((e) => ended.push(e));
    return { service, prisma, emitter, ended };
  }

  it('fires on leave and revokes the leaver’s room access', async () => {
    const { service, emitter, ended } = setup({ remaining: 2 });
    await service.leave('u2', 's1');
    expect(emitter.revokeRoomAccess).toHaveBeenCalledWith('u2', 'squad:s1');
    expect(ended).toEqual([
      { squadId: 's1', userId: 'u2', squadEmptied: false },
    ]);
  });

  it('marks the squad emptied when the last member leaves', async () => {
    const { service, prisma, ended } = setup({ remaining: 0 });
    await service.leave('u2', 's1');
    expect(prisma.squad.delete).toHaveBeenCalled();
    expect(ended).toEqual([
      { squadId: 's1', userId: 'u2', squadEmptied: true },
    ]);
  });

  it('fires on kick and revokes the kicked member’s room access (after the kicked event)', async () => {
    const { service, prisma, emitter, ended } = setup();
    prisma.squadMember.findUnique.mockResolvedValueOnce({
      id: 'leader-row',
      isLeader: true,
    });
    await service.kick('leader', 's1', 'u2');
    expect(emitter.emitToRoom).toHaveBeenCalledWith(
      'squad:s1',
      expect.objectContaining({ type: 'squad.member.kicked', userId: 'u2' }),
    );
    expect(emitter.revokeRoomAccess).toHaveBeenCalledWith('u2', 'squad:s1');
    const kickedAt = emitter.emitToRoom.mock.invocationCallOrder[0];
    const revokedAt = emitter.revokeRoomAccess.mock.invocationCallOrder[0];
    expect(kickedAt).toBeLessThan(revokedAt);
    expect(ended).toEqual([
      { squadId: 's1', userId: 'u2', squadEmptied: false },
    ]);
  });

  it('LobbyWorldModule forgets the member / the squad on those events', () => {
    const { service } = setup();
    const world = new LobbyWorldService();
    const left = jest.spyOn(world, 'memberLeft');
    const emptied = jest.spyOn(world, 'squadEmptied');
    new LobbyWorldModule(service, world).onModuleInit();
    service.membershipEnded$.next({
      squadId: 's1',
      userId: 'u2',
      squadEmptied: false,
    });
    service.membershipEnded$.next({
      squadId: 's9',
      userId: 'u3',
      squadEmptied: true,
    });
    expect(left).toHaveBeenCalledWith('s1', 'u2');
    expect(emptied).toHaveBeenCalledWith('s9');
    world.onModuleDestroy();
  });
});
