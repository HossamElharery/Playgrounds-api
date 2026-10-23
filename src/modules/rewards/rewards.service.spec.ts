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
  const qualification = { assess: jest.fn(async (): Promise<any> => ({ ok: true, moneyVerified: false, venueId: 'v1', userId: 'u1' })) };
  let trustedHandler: (u: string, b: string | null) => Promise<void> = async () => undefined;
  const trust = {
    onTrusted: jest.fn((h: any) => { trustedHandler = h; }),
    considerCheckIn: jest.fn(async () => 'candidate'),
  };
  const links = { areLinked: jest.fn(async () => false) };
  const svc = new RewardsService(prisma, grants as any, achievements as any, qualification as any, trust as any, links as any);
  return { svc, prisma, grants, achievements, qualification, trust, links, trusted: (u: string, b: string | null) => trustedHandler(u, b) };
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
  const booking = { bookingId: 'b1', userId: 'u1', courtId: 'c1', isFirstBooking: true };

  it('a booking that does not prove a real player counts for nothing', async () => {
    const { svc, qualification, trust, achievements, grants } = make({ referredById: 'ref' });
    qualification.assess.mockResolvedValue({ ok: false, reason: 'venue_insider' });
    await svc.onBookingCompleted(booking);
    expect(trust.considerCheckIn).not.toHaveBeenCalled();
    expect(achievements.bump).not.toHaveBeenCalled();
    expect(grants.grant).not.toHaveBeenCalled();
  });

  it('a qualifying check-in starts the trust cool-off and counts toward achievements', async () => {
    const { svc, trust, achievements } = make();
    await svc.onBookingCompleted(booking);
    expect(trust.considerCheckIn).toHaveBeenCalledWith('u1', 'b1', expect.objectContaining({ ok: true }));
    expect(achievements.bump).toHaveBeenCalledWith('u1', 'booking.completed');
  });

  it('bookings past the daily counted limit do not advance quests', async () => {
    const { svc, prisma, achievements } = make();
    achievements.bump.mockResolvedValue(0);
    await svc.onBookingCompleted(booking);
    expect(prisma.court.findUnique).not.toHaveBeenCalled();
  });

  it('pays booking coins and the first-booking bonus only for a qualifying booking, through the budgeted door', async () => {
    const { svc, grants, qualification } = make();
    await svc.payBookingCoins({ bookingId: 'b1', userId: 'u1', venueId: 'v1', coins: 30, firstBonus: 200 });
    expect(grants.grant).toHaveBeenCalledWith(expect.objectContaining({ reason: 'booking_completed', refKey: 'booking:b1', category: 'booking', venueId: 'v1', amount: 30 }));
    expect(grants.grant).toHaveBeenCalledWith(expect.objectContaining({ reason: 'first_booking_bonus', refKey: 'first_booking', category: 'booking', amount: 200 }));
    grants.grant.mockClear();
    qualification.assess.mockResolvedValue({ ok: false, reason: 'last_minute' });
    await svc.payBookingCoins({ bookingId: 'b2', userId: 'u1', venueId: 'v1', coins: 30, firstBonus: 200 });
    expect(grants.grant).not.toHaveBeenCalled();
  });

  it('the referral settles when the player becomes trusted, with a hold', async () => {
    const { svc, grants, trusted } = make({ referredById: 'ref' });
    void svc;
    await trusted('u1', 'b1');
    expect(grants.grant).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', amount: REFERRAL_BONUS_COINS, refKey: 'referral:joined', holdMs: REFERRAL_HOLD_MS }));
    expect(grants.grant).toHaveBeenCalledWith(expect.objectContaining({ userId: 'ref', amount: REFERRAL_BONUS_COINS, refKey: 'referral:invited:u1', holdMs: REFERRAL_HOLD_MS }));
  });

  it('an inviter over the monthly limit is not paid for more friends', async () => {
    const { prisma, grants, trusted } = make({ referredById: 'ref' });
    prisma.coinGrant.count.mockResolvedValue(REFERRAL_MONTHLY_CAP);
    await trusted('u1', 'b1');
    expect(grants.grant).toHaveBeenCalledTimes(1);
    expect(grants.grant).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }));
  });

  it('nobody is paid for referring themselves, or for inviting their own other account', async () => {
    const own = make({ referredById: 'u1' });
    await own.trusted('u1', 'b1');
    expect(own.grants.grant).not.toHaveBeenCalled();
    const twin = make({ referredById: 'ref' });
    twin.links.areLinked.mockResolvedValue(true);
    await twin.trusted('u1', 'b1');
    expect(twin.grants.grant).not.toHaveBeenCalled();
  });

  it('a trust without a booking (admin override) settles no referral', async () => {
    const { grants, trusted } = make({ referredById: 'ref' });
    await trusted('u1', null);
    expect(grants.grant).not.toHaveBeenCalled();
  });
});

describe('RewardsService reviews and MVP', () => {
  it('a review of a booking that proves nothing earns nothing', async () => {
    const { svc, grants, qualification } = make();
    qualification.assess.mockResolvedValue({ ok: false, reason: 'venue_insider' });
    await svc.onReviewSubmitted('u1', true, 'b1');
    expect(grants.grant).not.toHaveBeenCalled();
  });

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
