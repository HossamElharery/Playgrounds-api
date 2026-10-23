import { bookings, disconnect, futureSlot, makeUser, makeVenue, notifications, prisma, seedWorld } from './helpers/booking-harness';
import { AchievementsService } from '../src/modules/rewards/achievements.service';
import { CoinGrantService } from '../src/modules/rewards/coin-grant.service';
import { RewardsService } from '../src/modules/rewards/rewards.service';
import { ENGAGEMENT_DAILY_CAP_COINS } from '../src/modules/rewards/coins-policy';

jest.setTimeout(120_000);

const grants = new CoinGrantService(prisma, notifications);
const achievements = new AchievementsService(prisma, grants, notifications);
const rewards = new RewardsService(prisma, grants, achievements);
const balance = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).coinsBalance;
let key = 0;
const ref = () => `it-${Date.now()}-${(key += 1)}`;

describe('coins hardening (real Postgres)', () => {
  beforeAll(async () => {
    await seedWorld();
  });
  afterAll(disconnect);

  it('ships the default achievements with the migration', async () => {
    const rows = await prisma.achievement.findMany();
    expect(rows.length).toBe(24);
    expect(rows.find((r) => r.key === 'penalties_win_10')).toMatchObject({ metric: 'game.win.penalties', target: 10, rewardCoins: 80 });
  });

  it('keeps a stranger\'s reward pending, then pays it once when they become trusted', async () => {
    const u = await makeUser('stranger');
    const out = await grants.grant({ userId: u.row.id, amount: 80, reason: 'achievement:x', refKey: ref() });
    expect(out.status).toBe('pending');
    expect(await balance(u.row.id)).toBe(0);
    expect((await grants.pendingSummary(u.row.id))).toMatchObject({ trusted: false, pendingCoins: 80 });

    expect(await grants.markTrusted(u.row.id)).toBe(true);
    expect(await balance(u.row.id)).toBe(80);
    expect(await grants.markTrusted(u.row.id)).toBe(false); // trusted only once
    expect(await balance(u.row.id)).toBe(80);
    const ledger = await prisma.coinLedgerEntry.findMany({ where: { userId: u.row.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: 80, reason: 'achievement:x' });
  });

  it('pays one reward once however many requests race for it', async () => {
    const u = await makeUser('racer');
    await prisma.user.update({ where: { id: u.row.id }, data: { trustedAt: new Date() } });
    const k = ref();
    const results = await Promise.all(Array.from({ length: 8 }, () => grants.grant({ userId: u.row.id, amount: 50, reason: 'quest:x', refKey: k })));
    expect(results.filter((r) => r.status === 'paid')).toHaveLength(1);
    expect(await balance(u.row.id)).toBe(50);
    expect(await prisma.coinLedgerEntry.count({ where: { userId: u.row.id } })).toBe(1);
  });

  it('never pays more than the daily engagement cap, even in parallel', async () => {
    const u = await makeUser('capped');
    await prisma.user.update({ where: { id: u.row.id }, data: { trustedAt: new Date() } });
    await Promise.all(Array.from({ length: 10 }, () => grants.grant({ userId: u.row.id, amount: 30, reason: 'match_played:x', refKey: ref(), dailyCapped: true })));
    expect(await balance(u.row.id)).toBe(ENGAGEMENT_DAILY_CAP_COINS);
    const ledger = await prisma.coinLedgerEntry.aggregate({ where: { userId: u.row.id }, _sum: { amount: true } });
    expect(ledger._sum.amount).toBe(ENGAGEMENT_DAILY_CAP_COINS);
  });

  it('holds a reward until its time, then the sweep pays it', async () => {
    const u = await makeUser('held');
    await prisma.user.update({ where: { id: u.row.id }, data: { trustedAt: new Date() } });
    const out = await grants.grant({ userId: u.row.id, amount: 300, reason: 'referral_bonus', refKey: ref(), holdMs: 3_600_000 });
    expect(out.status).toBe('pending');
    await prisma.coinGrant.updateMany({ where: { userId: u.row.id }, data: { releaseAt: new Date(Date.now() - 1000) } });
    await grants.sweepNow();
    expect(await balance(u.row.id)).toBe(300);
  });

  it('completes an achievement once, with the reward waiting for trust, and caps wins per day', async () => {
    const u = await makeUser('winner');
    const a = await prisma.achievement.create({
      data: { key: ref(), metric: 'game.win.itgame', target: 3, rewardCoins: 40, titleEn: 'T', titleAr: 'ت' },
    });
    const counted: number[] = [];
    for (let i = 0; i < 7; i += 1) counted.push(await achievements.bump(u.row.id, 'game.win.itgame'));
    expect(counted).toEqual([1, 1, 1, 1, 1, 0, 0]); // five counted wins a day
    expect(await prisma.userAchievement.count({ where: { userId: u.row.id, achievementId: a.id } })).toBe(1);
    expect(await prisma.coinGrant.count({ where: { userId: u.row.id, refKey: `ach:${a.key}` } })).toBe(1);
    expect(await balance(u.row.id)).toBe(0);

    const [row] = (await achievements.listForUser(u.row.id)).filter((r) => r.key === a.key);
    expect(row).toMatchObject({ progress: 3, target: 3, rewardStatus: 'pending' });

    await grants.markTrusted(u.row.id);
    expect(await balance(u.row.id)).toBe(40);
  });

  it('parallel progress never over-counts', async () => {
    const u = await makeUser('parallel');
    const counted = await Promise.all(Array.from({ length: 10 }, () => achievements.bump(u.row.id, 'booking.completed')));
    const added = counted.reduce((a, b) => a + b, 0);
    const row = await prisma.userMetric.findUniqueOrThrow({ where: { userId_metric: { userId: u.row.id, metric: 'booking.completed' } } });
    expect(row.value).toBe(added);
    expect(added).toBeLessThanOrEqual(10);
  });

  it('a daily check-in done on two devices at once pays one day', async () => {
    const u = await makeUser('checkin');
    await prisma.user.update({ where: { id: u.row.id }, data: { trustedAt: new Date() } });
    const results = await Promise.all(Array.from({ length: 6 }, () => rewards.dailyCheckIn(u.row.id)));
    expect(results.filter((r) => !r.alreadyCheckedIn)).toHaveLength(1);
    expect(await balance(u.row.id)).toBe(5);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: u.row.id } });
    expect(fresh.streakCount).toBe(1);
  });

  it('a weekly quest pays once per week even when finished by parallel requests', async () => {
    const u = await makeUser('quester');
    await prisma.user.update({ where: { id: u.row.id }, data: { trustedAt: new Date() } });
    const q = await prisma.quest.create({ data: { key: ref(), titleEn: 'q', titleAr: 'ق', rule: { event: 'checkin.daily', target: 1 }, rewardCoins: 100 } });
    await Promise.all(Array.from({ length: 5 }, () => rewards.bumpQuestsForEvent(u.row.id, 'checkin.daily')));
    expect(await prisma.coinLedgerEntry.count({ where: { userId: u.row.id, reason: `quest:${q.key}` } })).toBe(1);
    await prisma.quest.update({ where: { id: q.id }, data: { active: false } });
  });

  it('settles a referral only at the first paid check-in, with a hold, and not twice', async () => {
    const inviter = await makeUser('inviter');
    const friend = await makeUser('friend');
    await prisma.user.update({ where: { id: inviter.row.id }, data: { trustedAt: new Date() } });
    await prisma.user.update({ where: { id: friend.row.id }, data: { referredById: inviter.row.id } });
    const { courts } = await makeVenue((await makeUser('own', ['owner'])).row.id, (await seedWorld()).sportId, 1);
    const held = await bookings.holdSlot(friend.row.id, { courtId: courts[0].id, slotStart: futureSlot().toISOString() });
    const params = { bookingId: held.id, userId: friend.row.id, courtId: courts[0].id, isFirstBooking: true, totalAmount: 20000, source: 'platform' };
    await rewards.onBookingCompleted({ ...params, totalAmount: 0 }); // free: nothing happens
    expect((await prisma.user.findUniqueOrThrow({ where: { id: friend.row.id } })).trustedAt).toBeNull();
    await rewards.onBookingCompleted(params);
    await rewards.onBookingCompleted({ ...params, isFirstBooking: false });
    expect(await prisma.coinGrant.count({ where: { reason: 'referral_bonus', userId: { in: [inviter.row.id, friend.row.id] } } })).toBe(2);
    expect(await balance(friend.row.id)).toBe(0); // held for a week
    await prisma.coinGrant.updateMany({ where: { reason: 'referral_bonus', userId: { in: [inviter.row.id, friend.row.id] } }, data: { releaseAt: new Date(Date.now() - 1000) } });
    await grants.sweepNow();
    expect(await balance(friend.row.id)).toBe(300);
    expect(await balance(inviter.row.id)).toBe(300);
  });
});
