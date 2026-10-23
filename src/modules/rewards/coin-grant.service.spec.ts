import { CoinGrantService } from './coin-grant.service';
import { ENGAGEMENT_DAILY_CAP_COINS, USER_BOOKING_COINS_PER_DAY, VENUE_DAILY_COIN_BUDGET } from './coins-policy';

type GrantRow = {
  id: string;
  userId: string;
  amount: number;
  reason: string;
  status: string;
  requiresTrust: boolean;
  dailyCapped: boolean;
  releaseAt: Date | null;
  bookingId: string | null;
  category: string;
  venueId: string | null;
  user: { trustedAt: Date | null; status: string; rewardsBlockedAt?: Date | null };
};

function make(row: Partial<GrantRow> = {}, paidToday = 0, venuePaid = 0) {
  const grant: GrantRow = {
    id: 'g1',
    userId: 'u1',
    amount: 100,
    reason: 'achievement:x',
    status: 'pending',
    requiresTrust: true,
    dailyCapped: false,
    releaseAt: null,
    bookingId: null,
    category: 'engagement',
    venueId: null,
    user: { trustedAt: new Date(), status: 'active' },
    ...row,
  };
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    coinGrant: {
      findUnique: jest.fn(async () => grant),
      aggregate: jest.fn(async (args: any) => ({ _sum: { amount: args.where.venueId ? venuePaid : paidToday } })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    user: { update: jest.fn(async () => undefined) },
    coinLedgerEntry: { create: jest.fn(async () => undefined) },
  };
  const prisma: any = {
    coinGrant: {
      create: jest.fn(async () => ({ id: 'g1' })),
      findUnique: jest.fn(async () => grant),
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
      aggregate: jest.fn(),
    },
    user: { updateMany: jest.fn(async () => ({ count: 1 })), findUnique: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    $queryRaw: jest.fn(async () => [{ acquired: true }]),
  };
  const notifications = { create: jest.fn(async () => null) };
  const svc = new CoinGrantService(prisma, notifications as any);
  return { svc, tx, prisma, notifications };
}

describe('CoinGrantService', () => {
  it('pays a trusted player at once: balance, ledger and the grant itself', async () => {
    const { svc, tx } = make();
    const out = await svc.grant({ userId: 'u1', amount: 100, reason: 'achievement:x', refKey: 'ach:x' });
    expect(out).toEqual({ status: 'paid', amount: 100 });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { coinsBalance: { increment: 100 } } });
    expect((tx.coinLedgerEntry.create.mock.calls[0] as any[])[0].data).toMatchObject({ userId: 'u1', amount: 100, reason: 'achievement:x' });
    expect((tx.coinGrant.updateMany.mock.calls[0] as any[])[0].where).toEqual({ id: 'g1', status: 'pending' });
  });

  it('keeps the reward pending for a player who never had a paid booking checked in', async () => {
    const { svc, tx } = make({ user: { trustedAt: null, status: 'active' } });
    const out = await svc.grant({ userId: 'u1', amount: 100, reason: 'daily_checkin', refKey: 'checkin:d' });
    expect(out).toEqual({ status: 'pending', amount: 100 });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.coinLedgerEntry.create).not.toHaveBeenCalled();
  });

  it('never pays the same reward twice (unique refKey)', async () => {
    const { svc, prisma, tx } = make();
    prisma.coinGrant.create.mockRejectedValue({ code: 'P2002' });
    expect(await svc.grant({ userId: 'u1', amount: 5, reason: 'r', refKey: 'k' })).toEqual({ status: 'duplicate', amount: 0 });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('does not pay a grant someone else already paid or voided (lost race)', async () => {
    const { svc, tx } = make();
    tx.coinGrant.updateMany.mockResolvedValue({ count: 0 });
    expect(await svc.release('g1')).toEqual({ status: 'duplicate', amount: 0 });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('holds a reward until its release time', async () => {
    const { svc, tx } = make({ releaseAt: new Date(Date.now() + 3_600_000) });
    expect((await svc.release('g1')).status).toBe('pending');
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('pays nothing to a suspended account', async () => {
    const { svc, tx } = make({ user: { trustedAt: new Date(), status: 'suspended' } });
    expect((await svc.release('g1')).status).toBe('pending');
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('trims a capped reward to what is left of the 24h engagement cap, under a per-player lock', async () => {
    const { svc, tx } = make({ dailyCapped: true, amount: 30 }, ENGAGEMENT_DAILY_CAP_COINS - 12);
    const out = await svc.release('g1');
    expect(out).toEqual({ status: 'paid', amount: 12 });
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { coinsBalance: { increment: 12 } } });
  });

  it('voids a capped reward when the cap is already used up', async () => {
    const { svc, tx } = make({ dailyCapped: true, amount: 30 }, ENGAGEMENT_DAILY_CAP_COINS);
    expect(await svc.release('g1')).toEqual({ status: 'void', amount: 0 });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect((tx.coinGrant.updateMany.mock.calls[0] as any[])[0].data).toEqual({ status: 'void' });
  });

  it('does not reward zero or negative amounts', async () => {
    const { svc, prisma } = make();
    expect((await svc.grant({ userId: 'u1', amount: 0, reason: 'r', refKey: 'k' })).status).toBe('void');
    expect(prisma.coinGrant.create).not.toHaveBeenCalled();
  });

  it('makes a player trusted once and pays what was waiting', async () => {
    const { svc, prisma } = make();
    prisma.coinGrant.findMany.mockResolvedValueOnce([{ id: 'g1' }, { id: 'g2' }]);
    expect(await svc.markTrusted('u1')).toBe(true);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: 'u1', trustedAt: null }, data: { trustedAt: expect.any(Date) } });
    prisma.user.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await svc.markTrusted('u1')).toBe(false);
  });

  it('the sweep voids very old pending grants and pays the ones whose hold ended', async () => {
    const { svc, prisma } = make();
    prisma.coinGrant.updateMany.mockResolvedValueOnce({ count: 3 });
    prisma.coinGrant.findMany.mockResolvedValueOnce([{ id: 'g1' }]);
    expect(await svc.sweepNow()).toEqual({ paid: 1, voided: 3 });
  });

  it('pays nothing to an account an admin blocked from rewards', async () => {
    const { svc, tx } = make({ user: { trustedAt: new Date(), status: 'active', rewardsBlockedAt: new Date() } });
    expect((await svc.release('g1')).status).toBe('pending');
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  describe('booking coin budgets', () => {
    const booking = { category: 'booking', venueId: 'v1', amount: 100 };

    it('pays booking coins inside both budgets, under a lock on the player and the venue', async () => {
      const { svc, tx } = make(booking, 0, 0);
      expect(await svc.release('g1')).toEqual({ status: 'paid', amount: 100 });
      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('trims to what is left of the player\'s daily booking budget', async () => {
      const { svc } = make(booking, USER_BOOKING_COINS_PER_DAY - 40, 0);
      expect(await svc.release('g1')).toEqual({ status: 'paid', amount: 40 });
    });

    it('trims to what is left of the venue\'s daily budget, so a farm venue cannot print coins', async () => {
      const { svc } = make(booking, 0, VENUE_DAILY_COIN_BUDGET - 25);
      expect(await svc.release('g1')).toEqual({ status: 'paid', amount: 25 });
    });

    it('voids the coins once the venue budget is gone', async () => {
      const { svc, tx } = make(booking, 0, VENUE_DAILY_COIN_BUDGET);
      expect(await svc.release('g1')).toEqual({ status: 'void', amount: 0 });
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('stores the venue and category on the grant', async () => {
      const { svc, prisma } = make();
      await svc.grant({ userId: 'u1', amount: 10, reason: 'booking_completed', refKey: 'booking:b', category: 'booking', venueId: 'v1' });
      expect((prisma.coinGrant.create.mock.calls[0] as any[])[0].data).toMatchObject({ category: 'booking', venueId: 'v1' });
    });
  });
});
