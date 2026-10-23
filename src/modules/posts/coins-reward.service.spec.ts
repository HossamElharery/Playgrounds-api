import { CoinsRewardService } from './coins-reward.service';

describe('CoinsRewardService', () => {
  const prisma = {
    coinsRewardRule: { findMany: jest.fn() },
    post: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
    postLike: { findMany: jest.fn() },
    user: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const grants = { grant: jest.fn() };
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
    prisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    prisma.post.findUnique.mockResolvedValue({ authorId: 'u1' });
    prisma.post.updateMany.mockResolvedValue({ count: 1 });
    grants.grant.mockResolvedValue({ status: 'paid', amount: 15 });
    service = new CoinsRewardService(
      prisma as never,
      notifications as never,
      analytics as never,
      hashtags as never,
      grants as never,
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

    const first = await service.evaluate();
    expect(first.awarded).toBe(1);
    expect(grants.grant).toHaveBeenCalledWith({
      userId: 'u1',
      amount: 15,
      reason: 'post_engagement_reward',
      refKey: 'post:p1',
    });
    expect(analytics.emit).toHaveBeenCalledWith('coins_awarded_post', 'u1', {
      postId: 'p1',
      coins: 15,
    });

    prisma.post.findMany.mockResolvedValueOnce([]);
    const second = await service.evaluate();
    expect(second.awarded).toBe(0);
    expect(grants.grant).toHaveBeenCalledTimes(1);

    const where = prisma.post.findMany.mock.calls[0][0].where;
    expect(where.authorKind).toBe('user');
    expect(where.coinsAwarded).toBe(false);
  });

  it('pays nothing when another runner already claimed the post', async () => {
    prisma.post.findMany.mockResolvedValueOnce([
      { id: 'p1', slug: 's', authorId: 'u1', likeCount: 4, author: { postingRestriction: null } },
    ]);
    prisma.post.updateMany.mockResolvedValue({ count: 0 });
    const out = await service.evaluate();
    expect(out.awarded).toBe(0);
    expect(grants.grant).not.toHaveBeenCalled();
  });

  it('ignores the author\'s own like and likes from guests or brand-new accounts', async () => {
    prisma.post.findMany.mockResolvedValueOnce([
      { id: 'p1', slug: 's', authorId: 'u1', likeCount: 4, author: { postingRestriction: null } },
    ]);
    await service.evaluate();
    const where = prisma.postLike.findMany.mock.calls[0][0].where;
    expect(where.userId).toEqual({ not: 'u1' });
    expect(where.user.isGuest).toBe(false);
    expect(where.user.status).toBe('active');
  });
});
