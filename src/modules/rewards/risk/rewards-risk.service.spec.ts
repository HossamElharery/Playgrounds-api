import { RewardsRiskService } from './rewards-risk.service';
import { VENUE_DAILY_COIN_BUDGET, VENUE_NEW_TRUST_PER_WEEK } from '../coins-policy';

function make(over: { trusted?: any[]; coins?: any[]; frozen?: any[]; shared?: any[]; rows?: any[] } = {}) {
  const prisma: any = {
    user: {
      groupBy: jest.fn(async () => over.trusted ?? []),
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => [{ id: 'admin1' }, { id: 'admin2' }]),
    },
    coinGrant: { groupBy: jest.fn(async () => over.coins ?? []) },
    venue: {
      findMany: jest.fn(async (args: any) =>
        args.where.rewardsFrozenAt
          ? over.frozen ?? []
          : [{ id: 'v1', nameEn: 'Venue One', nameAr: 'ملعب واحد', rewardsFrozenAt: null }],
      ),
    },
    userDevice: {
      groupBy: jest.fn(async () => over.shared ?? []),
      findMany: jest.fn(async () => over.rows ?? []),
    },
    $queryRaw: jest.fn(async () => [{ acquired: true }]),
  };
  const notifications = { create: jest.fn(async () => null) };
  return { svc: new RewardsRiskService(prisma, notifications as any), prisma, notifications };
}

describe('RewardsRiskService', () => {
  it('ranks venues by the new players they created this week', async () => {
    const { svc } = make({ trusted: [{ trustVenueId: 'v1', _count: { _all: 6 } }], coins: [{ venueId: 'v1', _sum: { amount: 300 } }] });
    expect(await svc.venues()).toEqual([{ venueId: 'v1', name: 'ملعب واحد', newTrusted7d: 6, coins24h: 300, frozen: false }]);
  });

  it('lists devices shared by several accounts', async () => {
    const { svc } = make({
      shared: [{ deviceHash: 'd1', _count: { userId: 2 } }],
      rows: [
        { deviceHash: 'd1', user: { id: 'a', name: 'A', trustedAt: new Date() } },
        { deviceHash: 'd1', user: { id: 'b', name: 'B', trustedAt: null } },
      ],
    });
    const [c] = await svc.clusters();
    expect(c.users.map((u) => u.id)).toEqual(['a', 'b']);
  });

  it('tells every admin when a venue nears its new-player limit or coin budget', async () => {
    const { svc, notifications } = make({ trusted: [{ trustVenueId: 'v1', _count: { _all: VENUE_NEW_TRUST_PER_WEEK } }] });
    expect(await svc.alertNow()).toEqual({ venues: 1, clusters: 0 });
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect((notifications.create.mock.calls[0] as any[])[0]).toMatchObject({ category: 'system', deepLink: '/admin/rewards' });
    const budget = make({ coins: [{ venueId: 'v1', _sum: { amount: VENUE_DAILY_COIN_BUDGET } }] });
    expect((await budget.svc.alertNow()).venues).toBe(1);
  });

  it('stays quiet when nothing looks wrong', async () => {
    const { svc, notifications } = make({ trusted: [{ trustVenueId: 'v1', _count: { _all: 1 } }] });
    expect(await svc.alertNow()).toEqual({ venues: 0, clusters: 0 });
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
