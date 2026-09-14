import { JobsService } from './jobs.service';

describe('Coin inactivity expiry', () => {
  const prisma = {
    user: { findMany: jest.fn(), update: jest.fn() },
    coinLedgerEntry: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const notifications = { create: jest.fn().mockResolvedValue(null) };
  let service: JobsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));
    notifications.create.mockResolvedValue(null);
    service = new JobsService(prisma as never, { emitToRoom: jest.fn(), emitToUser: jest.fn() } as never, notifications as never);
  });

  it('queries by lastSeenAt, not updatedAt — a socket ping must not reset the inactivity clock', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    await service.expireInactiveCoins();
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).not.toContain('updatedAt');
    expect(JSON.stringify(where)).toContain('lastSeenAt');
  });

  it('zeroes the balance, logs the ledger entry, and notifies the player', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', coinsBalance: 500 }]);
    await service.expireInactiveCoins();
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { coinsBalance: 0 } });
    expect(prisma.coinLedgerEntry.create).toHaveBeenCalledWith({
      data: { userId: 'u1', amount: -500, reason: 'inactivity_expiry' },
    });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', category: 'system' }),
    );
  });
});

describe('Booking hold expiry', () => {
  const prisma = {
    booking: { findMany: jest.fn(), updateMany: jest.fn() },
    user: { update: jest.fn() },
    coinLedgerEntry: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  let service: JobsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    service = new JobsService(prisma as never, { emitToRoom: jest.fn(), emitToUser: jest.fn() } as never, { create: jest.fn() } as never);
  });

  it('restores coins that were reserved on a hold that lapsed unconfirmed', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: 'b1', userId: 'u1', coinsRedeemed: 300 }]);
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    await service.expireBookingHolds();
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: 'b1', status: 'held' },
      data: { status: 'cancelled', holdExpiresAt: null },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { coinsBalance: { increment: 300 } },
    });
    expect(prisma.coinLedgerEntry.create).toHaveBeenCalledWith({
      data: { userId: 'u1', amount: 300, reason: 'booking_cancel_restore', bookingId: 'b1' },
    });
  });

  it('does not touch coins for a hold that never redeemed any', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: 'b1', userId: 'u1', coinsRedeemed: 0 }]);
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    await service.expireBookingHolds();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('does not double-restore a hold someone else already resolved', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: 'b1', userId: 'u1', coinsRedeemed: 300 }]);
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });
    await service.expireBookingHolds();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('Pulse rescue opportunity sync', () => {
  const prisma = {
    matchPost: { findMany: jest.fn() },
    pulseOpportunity: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  };
  let service: JobsService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new JobsService(prisma as never, { emitToRoom: jest.fn(), emitToUser: jest.fn() } as never, { create: jest.fn() } as never);
  });

  it('creates a rescue opportunity for an open, upcoming, short-handed match with no opportunity yet', async () => {
    prisma.matchPost.findMany.mockResolvedValue([
      { id: 'm1', authorId: 'a1', sportId: 's1', districtId: null, dateTime: new Date(Date.now() + 3_600_000), playersNeeded: 2, skillTier: null, costPerPlayerAmount: 5000, currency: 'EGP' },
    ]);
    prisma.pulseOpportunity.findMany.mockResolvedValue([]);
    await service.syncPulseRescueOpportunities();
    expect(prisma.pulseOpportunity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'rescue', matchPostId: 'm1', capacity: 2, urgent: false }),
    });
  });

  it('does not duplicate an opportunity that already exists for the match', async () => {
    prisma.matchPost.findMany.mockResolvedValue([
      { id: 'm1', authorId: 'a1', sportId: 's1', districtId: null, dateTime: new Date(Date.now() + 3_600_000), playersNeeded: 1, skillTier: null, costPerPlayerAmount: 0, currency: 'EGP' },
    ]);
    prisma.pulseOpportunity.findMany.mockResolvedValue([{ id: 'opp1', matchPostId: 'm1', capacity: 1 }]);
    await service.syncPulseRescueOpportunities();
    expect(prisma.pulseOpportunity.create).not.toHaveBeenCalled();
    expect(prisma.pulseOpportunity.update).not.toHaveBeenCalled();
  });

  it('updates capacity when the match still needs a different number of players', async () => {
    prisma.matchPost.findMany.mockResolvedValue([
      { id: 'm1', authorId: 'a1', sportId: 's1', districtId: null, dateTime: new Date(Date.now() + 3_600_000), playersNeeded: 1, skillTier: null, costPerPlayerAmount: 0, currency: 'EGP' },
    ]);
    prisma.pulseOpportunity.findMany.mockResolvedValue([{ id: 'opp1', matchPostId: 'm1', capacity: 3 }]);
    await service.syncPulseRescueOpportunities();
    expect(prisma.pulseOpportunity.update).toHaveBeenCalledWith({
      where: { id: 'opp1' },
      data: expect.objectContaining({ capacity: 1, urgent: true }),
    });
  });

  it('expires the opportunity once its match post is no longer open and short-handed', async () => {
    prisma.matchPost.findMany.mockResolvedValue([]);
    prisma.pulseOpportunity.findMany.mockResolvedValue([{ id: 'opp1', matchPostId: 'm-filled', capacity: 1 }]);
    await service.syncPulseRescueOpportunities();
    expect(prisma.pulseOpportunity.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['opp1'] } },
      data: { status: 'expired' },
    });
  });
});
