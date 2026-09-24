import { SquadService } from './squad.service';

/** Lobby Morphs integration: `mySquad` members carry `morphId` only while the flag is on. */
describe('SquadService.mySquad morphId', () => {
  const squadRow = (withProfile: boolean) => ({
    squad: {
      id: 'sq1',
      createdAt: new Date(),
      members: [
        {
          id: 'm1',
          squadId: 'sq1',
          userId: 'u1',
          isLeader: true,
          micMuted: false,
          joinedAt: new Date(),
          user: {
            id: 'u1',
            name: 'A',
            avatarUrl: null,
            avatarConfig: null,
            isGuest: false,
            ...(withProfile
              ? { morphProfile: { equippedMorphId: 'dino' } }
              : {}),
          },
        },
        {
          id: 'm2',
          squadId: 'sq1',
          userId: 'u2',
          isLeader: false,
          micMuted: false,
          joinedAt: new Date(),
          user: {
            id: 'u2',
            name: 'B',
            avatarUrl: null,
            avatarConfig: null,
            isGuest: true,
            ...(withProfile ? { morphProfile: null } : {}),
          },
        },
      ],
    },
  });

  function setup(enabled: boolean) {
    const prisma: any = {
      squadMember: { findFirst: jest.fn(async () => squadRow(enabled)) },
      user: { update: jest.fn(async () => ({})) },
    };
    const presence: any = { touch: () => false, isSquadConnected: () => true };
    const config: any = {
      get: (k: string) =>
        k === 'LOBBY_MORPHS_ENABLED' && enabled ? 'true' : undefined,
    };
    const service = new SquadService(
      prisma,
      presence,
      {} as any,
      {} as any,
      config,
    );
    return { service, prisma };
  }

  it('maps each member to morphId (default classic) when enabled', async () => {
    const { service, prisma } = setup(true);
    const squad: any = await service.mySquad('u1');
    expect(squad.members.map((m: any) => m.morphId)).toEqual([
      'dino',
      'classic',
    ]);
    const select =
      prisma.squadMember.findFirst.mock.calls[0][0].include.squad.include
        .members.include.user.select;
    expect(select.morphProfile).toEqual({ select: { equippedMorphId: true } });
  });

  it('leaves the query and payload exactly as before when disabled', async () => {
    const { service, prisma } = setup(false);
    const squad: any = await service.mySquad('u1');
    expect(squad.members.every((m: any) => !('morphId' in m))).toBe(true);
    const select =
      prisma.squadMember.findFirst.mock.calls[0][0].include.squad.include
        .members.include.user.select;
    expect(select).toEqual({
      id: true,
      name: true,
      avatarUrl: true,
      avatarConfig: true,
      isGuest: true,
    });
  });
});
