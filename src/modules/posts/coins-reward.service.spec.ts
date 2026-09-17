import { CoinsRewardService } from './coins-reward.service';

describe('CoinsRewardService', () => {
  const prisma = {
    coinsRewardRule: { findMany: jest.fn() },
    post: { findMany: jest.fn(), update: jest.fn() },
    postLike: { findMany: jest.fn() },
    user: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    coinLedgerEntry: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const notifications = { create: jest.fn() };
  const analytics = { emit: jest.fn() };
  const hashtags = { refreshTrendingScores: jest.fn() };
  let service: CoinsRewardService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.coinsRewardRule.findMany.mockResolvedValue([
      { id: 'r1', metric: 'like_count', threshold: 2, coinsAwarded: 15, active: true },
    ]);
    prisma.postLike.findMany.mockResolvedValue([
      { createdAt: new Date(Date.now() - 120_000) },
      { createdAt: new Date(Date.now() - 60_000) },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.user.update.mockResolvedValue({ id: 'u1' });
    prisma.coinLedgerEntry.create.mockResolvedValue({ id: 'l1' });
    prisma.$transaction.mockImplementation(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    );
    service = new CoinsRewardService(
      prisma as never,
      notifications as never,
      analytics as never,
      hashtags as never,
    );
  });

  it('awards a user post once and never an official post', async () => {
    prisma.post.findMany.mockResolvedValueOnce([
      {
        id: 'p1',
        slug: 'night-game',
        authorId: 'u1',
        likeCount: 4,
        author: { postingRestriction: null },
      },
    ]);
    prisma.post.update.mockResolvedValue({ id: 'p1', coinsAwarded: true });

    const first = await service.evaluate();
    expect(first.awarded).toBe(1);
    expect(prisma.coinLedgerEntry.create).toHaveBeenCalledWith({
      data: { userId: 'u1', amount: 15, reason: 'post_engagement_reward' },
    });
    expect(analytics.emit).toHaveBeenCalledWith('coins_awarded_post', 'u1', {
      postId: 'p1',
      coins: 15,
    });

    prisma.post.findMany.mockResolvedValueOnce([]);
    const second = await service.evaluate();
    expect(second.awarded).toBe(0);
    expect(prisma.coinLedgerEntry.create).toHaveBeenCalledTimes(1);

    const where = prisma.post.findMany.mock.calls[0][0].where;
    expect(where.authorKind).toBe('user');
    expect(where.coinsAwarded).toBe(false);
  });
});
