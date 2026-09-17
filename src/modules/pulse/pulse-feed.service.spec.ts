import { PulseService } from './pulse.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';

describe('PulseService ready-player feed', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    friendship: { findMany: jest.fn() },
    userBlock: { findMany: jest.fn() },
    pulseOpportunity: { findMany: jest.fn(), count: jest.fn() },
    pulseAvailability: { findMany: jest.fn(), count: jest.fn() },
  };
  let service: PulseService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ countryCode: 'EG' });
    prisma.friendship.findMany.mockResolvedValue([
      { requesterId: 'me', addresseeId: 'friend' },
    ]);
    prisma.userBlock.findMany.mockResolvedValue([]);
    prisma.pulseOpportunity.findMany.mockResolvedValue([]);
    prisma.pulseOpportunity.count.mockResolvedValue(0);
    prisma.pulseAvailability.count.mockResolvedValue(1);
    prisma.pulseAvailability.findMany.mockResolvedValue([
      {
        userId: 'friend',
        sportId: 'sport-football',
        window: 'now',
        mode: 'casual',
        radiusKm: 10,
        maxBudgetAmount: 15000,
        currency: 'EGP',
        expiresAt: new Date(Date.now() + 10 * 60_000),
        sport: {
          id: 'sport-football',
          slug: 'football',
          nameEn: 'Football',
          nameAr: 'كرة القدم',
        },
        user: {
          id: 'friend',
          name: 'Ready Friend',
          avatarUrl: null,
          reliabilityPct: 100,
          sportSkills: [{ sportId: 'sport-football', tier: 'silver' }],
        },
      },
    ]);
    service = new PulseService(
      prisma as unknown as PrismaService,
      {
        emitToUser: jest.fn(),
        emitToRoom: jest.fn(),
      } as unknown as RealtimeGatewayEmitter,
      { requestJoin: jest.fn() } as never,
    );
  });

  it('returns the actual active players counted by the ready metric', async () => {
    const feed = await service.feed('me', { limit: 20 } as never);

    expect(feed.metrics.readyNearby).toBe(1);
    expect(feed.readyPlayers).toEqual([
      expect.objectContaining({
        userId: 'friend',
        name: 'Ready Friend',
        isFriend: true,
        sportSlug: 'football',
      }),
    ]);
    expect(prisma.pulseAvailability.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: expect.objectContaining({ notIn: ['me'] }),
          user: { countryCode: 'EG' },
          status: 'active',
        }),
      }),
    );
  });
});
