import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UsersService } from './users.service';

describe('UsersService.updateProfile', () => {
  let prisma: {
    user: { update: jest.Mock };
  };
  let service: UsersService;

  beforeEach(() => {
    prisma = { user: { update: jest.fn() } };
    service = new UsersService(
      prisma as never,
      { emitToUser: jest.fn() } as never,
      {} as never,
    );
  });

  it('saves an optional E.164 phone without OTP', async () => {
    prisma.user.update.mockResolvedValue({
      id: 'u1',
      name: 'Omar',
      phone: '+201001112223',
    });
    const result = await service.updateProfile('u1', {
      name: 'Omar',
      phone: '+201001112223',
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: expect.objectContaining({ phone: '+201001112223', name: 'Omar' }),
    });
    expect(result.phone).toBe('+201001112223');
  });

  it('clears the phone when the client sends null', async () => {
    prisma.user.update.mockResolvedValue({ id: 'u1', phone: null });
    await service.updateProfile('u1', { phone: null });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: expect.objectContaining({ phone: null }),
    });
  });

  it('rejects a phone that is already taken', async () => {
    prisma.user.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.updateProfile('u1', { phone: '+201001112223' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('UsersService guest exclusion', () => {
  const baseUser = {
    id: 'u1',
    name: 'Hala',
    avatarUrl: null,
    avatarConfig: null,
    bioAr: null,
    bioEn: null,
    reputation: 0,
    reliabilityPct: 100,
    matchesPlayed: 0,
    mvps: 0,
    streakCount: 0,
    isGuest: true,
    sportSkills: [],
    badges: [],
    teamMemberships: [],
  };

  it('never includes guests in the public players directory query', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new UsersService(
      { user: { findMany } } as never,
      {} as never,
      {} as never,
    );
    await service.listPlayers({} as never);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isGuest: false }),
      }),
    );
  });

  it('treats a guest profile as not found', async () => {
    const findUnique = jest.fn().mockResolvedValue(baseUser);
    const service = new UsersService(
      { user: { findUnique } } as never,
      {} as never,
      {} as never,
    );
    await expect(service.publicProfile('u1')).rejects.toThrow(
      'Player not found',
    );
  });
});
