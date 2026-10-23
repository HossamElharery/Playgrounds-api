import { AchievementsService } from './achievements.service';

function make(over: { metric?: any; defs?: any[]; completeFails?: boolean } = {}) {
  const prisma: any = {
    userMetric: {
      findUnique: jest.fn(async () => over.metric ?? null),
      create: jest.fn(async () => undefined),
      updateMany: jest.fn(async () => ({ count: 1 })),
      upsert: jest.fn(async () => undefined),
      findMany: jest.fn(async () => []),
    },
    achievement: {
      findMany: jest.fn(async () => over.defs ?? []),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userAchievement: {
      create: jest.fn(async () => {
        if (over.completeFails) throw { code: 'P2002' };
        return undefined;
      }),
      findMany: jest.fn(async () => []),
    },
    coinGrant: { findMany: jest.fn(async () => []) },
  };
  const grants = { grant: jest.fn(async () => ({ status: 'pending', amount: 80 })) };
  const notifications = { create: jest.fn(async () => null) };
  return { svc: new AchievementsService(prisma, grants as any, notifications as any), prisma, grants, notifications };
}

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const def = { id: 'a1', key: 'penalties_win_10', metric: 'game.win.penalties', target: 10, rewardCoins: 80, titleEn: 'Penalty Sniper', titleAr: 'قناص' };

describe('AchievementsService', () => {
  it('starts a counter and completes nothing before the target', async () => {
    const { svc, prisma, grants } = make();
    expect(await svc.bump('u1', 'game.win.penalties')).toBe(1);
    expect(prisma.userMetric.create).toHaveBeenCalledWith({ data: { userId: 'u1', metric: 'game.win.penalties', value: 1, dayKey: today, dayCount: 1 } });
    expect(grants.grant).not.toHaveBeenCalled();
  });

  it('completes an achievement at its target and queues the coin reward once', async () => {
    const { svc, grants, prisma } = make({ metric: { id: 'm', value: 9, dayKey: today, dayCount: 1, updatedAt: new Date() }, defs: [def] });
    await svc.bump('u1', 'game.win.penalties');
    expect(prisma.achievement.findMany.mock.calls[0][0].where).toEqual({ metric: 'game.win.penalties', active: true, target: { lte: 10 } });
    expect(grants.grant).toHaveBeenCalledWith({ userId: 'u1', amount: 80, reason: 'achievement:penalties_win_10', refKey: 'ach:penalties_win_10' });
  });

  it('does not pay again when the achievement was already completed', async () => {
    const { svc, grants } = make({ metric: { id: 'm', value: 11, dayKey: today, dayCount: 1, updatedAt: new Date() }, defs: [def], completeFails: true });
    await svc.bump('u1', 'game.win.penalties');
    expect(grants.grant).not.toHaveBeenCalled();
  });

  it('stops counting wins after the per-day cap, so a ring of two accounts cannot grind', async () => {
    const { svc, prisma } = make({ metric: { id: 'm', value: 20, dayKey: today, dayCount: 5, updatedAt: new Date() }, defs: [def] });
    expect(await svc.bump('u1', 'game.win.penalties')).toBe(0);
    expect(prisma.userMetric.updateMany).not.toHaveBeenCalled();
  });

  it('a new Cairo day resets the day count', async () => {
    const { svc, prisma } = make({ metric: { id: 'm', value: 20, dayKey: '2000-01-01', dayCount: 5, updatedAt: new Date() } });
    expect(await svc.bump('u1', 'game.win.penalties')).toBe(1);
    expect((prisma.userMetric.updateMany.mock.calls[0] as any[])[0].data).toMatchObject({ dayKey: today, dayCount: 1 });
  });

  it('never throws into the game that reported the result', async () => {
    const { svc, prisma } = make();
    prisma.userMetric.findUnique.mockRejectedValue(new Error('db down'));
    await expect(svc.bump('u1', 'game.win')).resolves.toBe(0);
  });

  it('setBest only moves a streak counter upward', async () => {
    const { svc, prisma } = make({ metric: { id: 'm', value: 9 } });
    await svc.setBest('u1', 'streak.best', 5);
    expect(prisma.userMetric.upsert).not.toHaveBeenCalled();
    await svc.setBest('u1', 'streak.best', 12);
    expect(prisma.userMetric.upsert).toHaveBeenCalled();
  });

  it('lists progress capped at the target and the state of the reward', async () => {
    const { svc, prisma } = make({ defs: [{ ...def, category: 'games', sortOrder: 10, icon: null, descEn: '', descAr: '' }] });
    prisma.userMetric.findMany.mockResolvedValue([{ metric: 'game.win.penalties', value: 14 }]);
    prisma.userAchievement.findMany.mockResolvedValue([{ achievementId: 'a1', completedAt: new Date('2026-10-01') }]);
    prisma.coinGrant.findMany.mockResolvedValue([{ refKey: 'ach:penalties_win_10', status: 'pending' }]);
    const [row] = await svc.listForUser('u1');
    expect(row).toMatchObject({ key: 'penalties_win_10', progress: 10, target: 10, rewardStatus: 'pending' });
  });
});
