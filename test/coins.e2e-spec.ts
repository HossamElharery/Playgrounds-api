import { bookings, disconnect, futureSlot, makeUser, makeVenue, notifications, prisma, seedWorld } from './helpers/booking-harness';
import { AchievementsService } from '../src/modules/rewards/achievements.service';
import { CoinGrantService } from '../src/modules/rewards/coin-grant.service';
import { RewardsService } from '../src/modules/rewards/rewards.service';
import { BookingQualificationService } from '../src/modules/rewards/risk/booking-qualification.service';
import { DeviceLinksService } from '../src/modules/rewards/risk/device-links.service';
import { TrustService } from '../src/modules/rewards/risk/trust.service';
import {
  ENGAGEMENT_DAILY_CAP_COINS,
  TRUST_COOLOFF_MS,
  VENUE_DAILY_COIN_BUDGET,
  VENUE_NEW_TRUST_PER_WEEK,
} from '../src/modules/rewards/coins-policy';

jest.setTimeout(120_000);

const grants = new CoinGrantService(prisma, notifications);
const achievements = new AchievementsService(prisma, grants, notifications);
const links = new DeviceLinksService(prisma);
const qualification = new BookingQualificationService(prisma, links);
const trust = new TrustService(prisma, grants, links, qualification);
const rewards = new RewardsService(prisma, grants, achievements, qualification, trust, links);
const HOUR = 3_600_000;
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

  /** A booking that really happened a few hours ago and was checked in by the venue's staff. */
  async function checkedInBooking(
    playerId: string,
    court: { id: string; venueId: string },
    staffId: string,
    over: Record<string, unknown> = {},
  ) {
    const held = await bookings.holdSlot(playerId, { courtId: court.id, slotStart: futureSlot(Math.floor(Math.random() * 900)).toISOString() });
    const start = new Date(Date.now() - 3 * HOUR);
    return prisma.booking.update({
      where: { id: held.id },
      data: {
        status: 'completed', totalAmount: 20000, source: 'platform',
        createdAt: new Date(Date.now() - 9 * HOUR), slotStart: start, slotEnd: new Date(start.getTime() + HOUR),
        checkedInAt: new Date(start.getTime() + 5 * 60_000), checkedInByUserId: staffId, ...over,
      },
    });
  }
  async function establishedVenue(patch: Record<string, unknown> = {}) {
    const owner = await makeUser('own', ['owner']);
    const { venue, courts } = await makeVenue(owner.row.id, (await seedWorld()).sportId, 1, { approvedAt: new Date(Date.now() - 60 * 24 * HOUR), ...patch });
    const staff = await makeUser('staff', ['staff']);
    return { owner, venue, court: courts[0], staff };
  }
  const reload = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });

  it('a qualifying check-in starts a 48h cool-off; only then is the player trusted and the waiting rewards and referral released', async () => {
    const { venue, court, staff } = await establishedVenue();
    const inviter = await makeUser('inviter');
    await prisma.user.update({ where: { id: inviter.row.id }, data: { trustedAt: new Date() } });
    const friend = await makeUser('friend');
    await prisma.user.update({ where: { id: friend.row.id }, data: { referredById: inviter.row.id } });
    await grants.grant({ userId: friend.row.id, amount: 80, reason: 'achievement:x', refKey: ref() });

    const b = await checkedInBooking(friend.row.id, court, staff.row.id);
    await rewards.onBookingCompleted({ bookingId: b.id, userId: friend.row.id, courtId: court.id, isFirstBooking: true });
    let u = await reload(friend.row.id);
    expect(u.trustedAt).toBeNull();
    expect(u.trustCandidateAt).not.toBeNull();
    expect(u.trustVenueId).toBe(venue.id);
    expect(await balance(friend.row.id)).toBe(0);

    await prisma.user.update({ where: { id: friend.row.id }, data: { trustCandidateAt: new Date(Date.now() - TRUST_COOLOFF_MS - 1000) } });
    expect(await trust.promoteDue()).toEqual({ trusted: 1, dropped: 0 });
    u = await reload(friend.row.id);
    expect(u.trustedAt).not.toBeNull();
    expect(await balance(friend.row.id)).toBe(80); // the waiting achievement reward
    const refs = await prisma.coinGrant.findMany({ where: { reason: 'referral_bonus', userId: { in: [inviter.row.id, friend.row.id] } } });
    expect(refs).toHaveLength(2);
    expect(refs.every((r) => r.status === 'pending' && r.releaseAt && r.releaseAt.getTime() > Date.now())).toBe(true); // 7-day hold
    await prisma.coinGrant.updateMany({ where: { id: { in: refs.map((r) => r.id) } }, data: { releaseAt: new Date(Date.now() - 1000) } });
    await grants.sweepNow();
    expect(await balance(inviter.row.id)).toBe(300);
    expect(await balance(friend.row.id)).toBe(380);
  });

  it('pays booking coins only for a booking that proves a real player', async () => {
    const { court, staff, owner } = await establishedVenue();
    const player = await makeUser('coinplayer');
    await prisma.user.update({ where: { id: player.row.id }, data: { trustedAt: new Date() } });
    const good = await checkedInBooking(player.row.id, court, staff.row.id);
    await rewards.payBookingCoins({ bookingId: good.id, userId: player.row.id, venueId: good.venueId, coins: 20, firstBonus: 150 });
    expect(await balance(player.row.id)).toBe(170);
    await rewards.payBookingCoins({ bookingId: good.id, userId: player.row.id, venueId: good.venueId, coins: 20, firstBonus: 150 });
    expect(await balance(player.row.id)).toBe(170); // same booking, same bonus: once

    const lastMinute = await checkedInBooking(player.row.id, court, staff.row.id, { createdAt: new Date(Date.now() - 20 * 60_000) });
    await rewards.payBookingCoins({ bookingId: lastMinute.id, userId: player.row.id, venueId: lastMinute.venueId, coins: 50, firstBonus: 0 });
    const own = await checkedInBooking(owner.row.id, court, staff.row.id);
    await rewards.payBookingCoins({ bookingId: own.id, userId: owner.row.id, venueId: own.venueId, coins: 50, firstBonus: 150 });
    expect(await balance(player.row.id)).toBe(170);
    expect(await balance(owner.row.id)).toBe(0);
  });

  it('an owner (or staff) playing their own venue never becomes a candidate', async () => {
    const { court, staff, owner } = await establishedVenue();
    const own = await checkedInBooking(owner.row.id, court, staff.row.id);
    await rewards.onBookingCompleted({ bookingId: own.id, userId: owner.row.id, courtId: court.id, isFirstBooking: true });
    expect((await reload(owner.row.id)).trustCandidateAt).toBeNull();
  });

  it('a venue can create only a few new trusted players a week', async () => {
    const { court, staff } = await establishedVenue();
    const results: Array<Date | null> = [];
    for (let i = 0; i < VENUE_NEW_TRUST_PER_WEEK + 2; i += 1) {
      const p = await makeUser(`farm${i}`);
      const b = await checkedInBooking(p.row.id, court, staff.row.id);
      await rewards.onBookingCompleted({ bookingId: b.id, userId: p.row.id, courtId: court.id, isFirstBooking: true });
      results.push((await reload(p.row.id)).trustCandidateAt);
    }
    expect(results.filter(Boolean)).toHaveLength(VENUE_NEW_TRUST_PER_WEEK);
  });

  it('freezing a venue drops its candidates at promotion and can undo recently trusted players', async () => {
    const { venue, court, staff } = await establishedVenue();
    const admin = await makeUser('admin', ['admin']);
    const a = await makeUser('frozenA');
    const bk = await checkedInBooking(a.row.id, court, staff.row.id);
    await rewards.onBookingCompleted({ bookingId: bk.id, userId: a.row.id, courtId: court.id, isFirstBooking: true });
    await prisma.user.update({ where: { id: a.row.id }, data: { trustCandidateAt: new Date(Date.now() - TRUST_COOLOFF_MS - 1000) } });
    await trust.setVenueFrozen(venue.id, admin.row.id, true, false);
    await trust.promoteDue();
    expect((await reload(a.row.id)).trustedAt).toBeNull();

    // already trusted from this venue, with coins: freezing + revoke recent takes it back
    await trust.setVenueFrozen(venue.id, admin.row.id, false, false);
    const c = await makeUser('frozenC');
    await prisma.user.update({ where: { id: c.row.id }, data: { trustedAt: new Date(), trustVenueId: venue.id, trustCandidateAt: new Date() } });
    await grants.grant({ userId: c.row.id, amount: 70, reason: 'achievement:y', refKey: ref() });
    expect(await balance(c.row.id)).toBe(70);
    const out = await trust.setVenueFrozen(venue.id, admin.row.id, true, true);
    expect(out.revoked).toBeGreaterThanOrEqual(1);
    expect((await reload(c.row.id)).trustedAt).toBeNull();
    expect(await balance(c.row.id)).toBe(0);
    expect(await prisma.auditLogEntry.count({ where: { actorUserId: admin.row.id } })).toBeGreaterThanOrEqual(3);
  });

  it('a candidate on the same device as an already trusted account is not trusted', async () => {
    const { court, staff } = await establishedVenue();
    const first = await makeUser('devA');
    const twin = await makeUser('devB');
    await prisma.user.update({ where: { id: first.row.id }, data: { trustedAt: new Date() } });
    await links.record(first.row.id, 'shared-device-id-0000000001');
    await links.record(twin.row.id, 'shared-device-id-0000000001');
    expect((await links.linkedIds(twin.row.id)).has(first.row.id)).toBe(true);
    const bk = await checkedInBooking(twin.row.id, court, staff.row.id);
    await rewards.onBookingCompleted({ bookingId: bk.id, userId: twin.row.id, courtId: court.id, isFirstBooking: true });
    await prisma.user.update({ where: { id: twin.row.id }, data: { trustCandidateAt: new Date(Date.now() - TRUST_COOLOFF_MS - 1000) } });
    await trust.promoteDue();
    expect((await reload(twin.row.id)).trustedAt).toBeNull();
  });

  it('the venue\'s daily coin budget holds even when many players claim at once', async () => {
    const { venue } = await establishedVenue();
    const players = await Promise.all(Array.from({ length: 20 }, (_, i) => makeUser(`budget${i}`)));
    await prisma.user.updateMany({ where: { id: { in: players.map((p) => p.row.id) } }, data: { trustedAt: new Date() } });
    await Promise.all(players.map((p, i) => grants.grant({ userId: p.row.id, amount: 100, reason: 'booking_completed', refKey: `b-${venue.id}-${i}`, category: 'booking', venueId: venue.id })));
    const paid = await prisma.coinGrant.aggregate({ where: { venueId: venue.id, status: 'paid' }, _sum: { amount: true } });
    expect(paid._sum.amount).toBe(VENUE_DAILY_COIN_BUDGET);
  });

  it('a blocked player earns nothing and an admin can trust a player directly', async () => {
    const admin = await makeUser('admin2', ['admin']);
    const u = await makeUser('blocked');
    await prisma.user.update({ where: { id: u.row.id }, data: { trustedAt: new Date() } });
    await trust.setBlocked(u.row.id, admin.row.id, true);
    expect((await grants.grant({ userId: u.row.id, amount: 10, reason: 'daily_checkin', refKey: ref() })).status).toBe('pending');
    expect(await balance(u.row.id)).toBe(0);
    expect(await trust.adminTrust(u.row.id, admin.row.id)).toBe(false); // already trusted, block cleared
    expect((await reload(u.row.id)).rewardsBlockedAt).toBeNull();
  });
});
