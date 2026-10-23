import { RewardsService } from './rewards.service';
import { cairoDayKey, REFERRAL_BONUS_COINS, REFERRAL_HOLD_MS, REFERRAL_MONTHLY_CAP } from './coins-policy';

const DAY = 86_400_000;

function make(user: Record<string, unknown> = {}) {
  const row = { id: 'u1', streakCount: 3, streakFreezes: 0, streakUpdatedAt: new Date(Date.now() - DAY), referredById: null, ...user };
  const prisma: any = {
    user: {
      findUniqueOrThrow: jest.fn(async () => row),
      findUnique: jest.fn(async () => row),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    quest: { findMany: jest.fn(async () => []) },
    court: { findUnique: jest.fn(async () => ({ sportId: 's', sport: { activityKind: 'field-sport' } })) },
    coinGrant: { count: jest.fn(async () => 0) },
    badge: { findUnique: jest.fn(async () => null) },
  };
  const grants = {
    grant: jest.fn(async (i: any) => ({ status: 'paid', amount: i.amount })),
    markTrusted: jest.fn(async () => true),
    pendingSummary: jest.fn(),
  };
  const achievements = { bump: jest.fn(async () => 1), setBest: jest.fn(async () => undefined) };
  return { svc: new RewardsService(prisma, grants as any, achievements as any), prisma, grants, achievements };
}

describe('RewardsService.dailyCheckIn', () => {
  it('pays 5 coins through the capped grant door, once per Cairo day', async () => {
    const { svc, grants, achievements } = make();
    const out = await svc.dailyCheckIn('u1');
    expect(grants.grant).toHaveBeenCalledWith({ userId: 'u1', amount: 5, reason: 'daily_checkin', refKey: `checkin:${cairoDayKey()}`, dailyCapped: true });
    expect(out).toMatchObject({ coins: 5, streak: 4, alreadyCheckedIn: false });
    expect(achievements.setBest).toHaveBeenCalledWith('u1', 'streak.best', 4);
  });

  it('a second tap the same day pays nothing', async () => {
    const { svc, grants } = make({ streakUpdatedAt: new Date() });
    expect((await svc.dailyCheckIn('u1')).alreadyCheckedIn).toBe(true);
    expect(grants.grant).not.toHaveBeenCalled();
  });

  it('two requests at the same instant: the one that loses the streak update pays nothing', async () => {
    const { svc, prisma, grants } = make();
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    expect((await svc.dailyCheckIn('u1')).alreadyCheckedIn).toBe(true);
    expect(grants.grant).not.toHaveBeenCalled();
    expect((prisma.user.updateMany.mock.calls[0] as any[])[0].where).toEqual({ id: 'u1', streakUpdatedAt: expect.any(Date) });
  });

  it('skipping a whole day breaks the streak even inside 48 hours', async () => {
    const lastLate = new Date(Date.parse(`${cairoDayKey(Date.now() - 2 * DAY)}T12:00:00Z`)); // midday two Cairo days ago
    const { svc } = make({ streakUpdatedAt: lastLate, streakCount: 10 });
    expect((await svc.dailyCheckIn('u1')).streak).toBe(1);
  });

  it('tells the player when the coins are waiting instead of paid', async () => {
    const { svc, grants } = make();
    grants.grant.mockResolvedValue({ status: 'pending', amount: 5 } as any);
    expect(await svc.dailyCheckIn('u1')).toMatchObject({ coins: 0, pendingCoins: 5 });
  });
});

describe('RewardsService.onBookingCompleted', () => {
  const booking = { bookingId: 'b1', userId: 'u1', courtId: 'c1', isFirstBooking: true, totalAmount: 20000 };

  it('a free or tiny booking proves nothing: no trust, no quest, no achievement', async () => {
    const { svc, grants, achievements } = make({ referredById: 'ref' });
    await svc.onBookingCompleted({ ...booking, totalAmount: 0 });
    expect(grants.markTrusted).not.toHaveBeenCalled();
    expect(achievements.bump).not.toHaveBeenCalled();
    expect(grants.grant).not.toHaveBeenCalled();
  });

  it('an owner-entered (manual) booking never makes a player trusted', async () => {
    const { svc, grants } = make();
    await svc.onBookingCompleted({ ...booking, source: 'manual' });
    expect(grants.markTrusted).not.toHaveBeenCalled();
  });

  it('the first paid check-in makes the player trusted and settles the referral with a hold', async () => {
    const { svc, grants } = make({ referredById: 'ref' });
    await svc.onBookingCompleted(booking);
    expect(grants.markTrusted).toHaveBeenCalledWith('u1');
    expect(grants.grant).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', amount: REFERRAL_BONUS_COINS, refKey: 'referral:joined', holdMs: REFERRAL_HOLD_MS }));
    expect(grants.grant).toHaveBeenCalledWith(expect.objectContaining({ userId: 'ref', amount: REFERRAL_BONUS_COINS, refKey: 'referral:invited:u1', holdMs: REFERRAL_HOLD_MS }));
  });

  it('later bookings never pay the referral again', async () => {
    const { svc, grants } = make({ referredById: 'ref' });
    grants.markTrusted.mockResolvedValue(false);
    await svc.onBookingCompleted({ ...booking, isFirstBooking: false });
    expect(grants.grant).not.toHaveBeenCalled();
  });

  it('an inviter over the monthly limit is not paid for more friends', async () => {
    const { svc, prisma, grants } = make({ referredById: 'ref' });
    prisma.coinGrant.count.mockResolvedValue(REFERRAL_MONTHLY_CAP);
    await svc.onBookingCompleted(booking);
    expect(grants.grant).toHaveBeenCalledTimes(1);
    expect(grants.grant).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }));
  });

  it('nobody is paid for referring themselves', async () => {
    const { svc, grants } = make({ referredById: 'u1' });
    await svc.onBookingCompleted(booking);
    expect(grants.grant).not.toHaveBeenCalled();
  });

  it('counts the booking toward the booking achievements', async () => {
    const { svc, achievements } = make();
    await svc.onBookingCompleted({ ...booking, isFirstBooking: false });
    expect(achievements.bump).toHaveBeenCalledWith('u1', 'booking.completed');
  });
});

describe('RewardsService reviews and MVP', () => {
  it('the photo bonus is one reward per booking, and only for a review with photos', async () => {
    const { svc, grants } = make();
    await svc.onReviewSubmitted('u1', false, 'b1');
    expect(grants.grant).not.toHaveBeenCalled();
    await svc.onReviewSubmitted('u1', true, 'b1');
    expect(grants.grant).toHaveBeenCalledWith(expect.objectContaining({ amount: 50, refKey: 'review_photo:b1' }));
  });

  it('an MVP vote from an unverified match moves no achievement', async () => {
    const { svc, achievements } = make();
    await svc.onMvpAwarded('u1', 1, false);
    expect(achievements.bump).not.toHaveBeenCalled();
    await svc.onMvpAwarded('u1', 2, true);
    expect(achievements.bump).toHaveBeenCalledWith('u1', 'mvp.awarded');
  });
});
