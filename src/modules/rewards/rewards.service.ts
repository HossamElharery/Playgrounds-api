import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePromoCodeDto } from './dto/create-promo-code.dto';
import { UpdatePromoCodeDto } from './dto/update-promo-code.dto';
import { CreateQuestDto } from './dto/create-quest.dto';
import { UpdateQuestDto } from './dto/update-quest.dto';
import { CreateBadgeDto } from './dto/create-badge.dto';
import { UpdateBadgeDto } from './dto/update-badge.dto';
import { UpdatePlatformSettingDto } from './dto/update-platform-setting.dto';
import { AchievementsService } from './achievements.service';
import { CoinGrantService } from './coin-grant.service';
import { BookingQualificationService } from './risk/booking-qualification.service';
import { DeviceLinksService } from './risk/device-links.service';
import { TrustService } from './risk/trust.service';
import {
  DAILY_CHECKIN_COINS,
  REFERRAL_BONUS_COINS,
  REFERRAL_HOLD_MS,
  REFERRAL_MONTHLY_CAP,
  REVIEW_PHOTO_BONUS_COINS,
  cairoDayKey,
} from './coins-policy';

const STREAK_MAX_MULTIPLIER = 3;
const STREAK_FREEZE_COST_COINS = 400;

interface QuestScope {
  activityKind?: string; // 'field-sport' | 'racket-court' | 'gaming-station' | 'table-game'
  activityId?: string; // a specific SportCategory id (a sport or, later, a game)
}

interface QuestRule {
  event?:
    | 'booking.completed'
    | 'checkin.daily'
    | 'match.mvp.awarded'
    | 'referral.completed'
    | 'review.submitted'
    | 'review.photo';
  target: number;
  scope?: QuestScope | null;
}

interface ActivityContext {
  activityId?: string;
  activityKind?: string | null;
}

function isoWeekKey(date: Date): string {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

@Injectable()
export class RewardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: CoinGrantService,
    private readonly achievements: AchievementsService,
    private readonly qualification: BookingQualificationService,
    private readonly trust: TrustService,
    private readonly links: DeviceLinksService,
  ) {
    // A player just became trusted: settle the referral that was waiting for it.
    this.trust.onTrusted((userId, bookingId) =>
      bookingId ? this.settleReferralIfAny(userId, bookingId) : Promise.resolve(),
    );
  }

  async wallet(userId: string) {
    const [user, ledger, pending] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { coinsBalance: true, streakCount: true, streakFreezes: true },
      }),
      this.prisma.coinLedgerEntry.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.grants.pendingSummary(userId),
    ]);
    return {
      balance: user.coinsBalance,
      streak: user.streakCount,
      streakFreezes: user.streakFreezes,
      ledger,
      pendingCoins: pending.pendingCoins,
      pendingCount: pending.pendingCount,
      trusted: pending.trusted,
    };
  }

  async dailyCheckIn(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const now = new Date();
    const today = cairoDayKey(now.getTime());
    const lastCheckIn = user.streakUpdatedAt;
    const isSameDay = !!lastCheckIn && cairoDayKey(lastCheckIn.getTime()) === today;
    if (isSameDay) {
      return {
        coins: 0,
        streak: user.streakCount,
        streakFreezes: user.streakFreezes,
        usedFreeze: false,
        alreadyCheckedIn: true,
      };
    }

    const yesterday = cairoDayKey(Date.parse(`${today}T12:00:00Z`) - 86_400_000);
    const isConsecutiveDay =
      !!lastCheckIn && cairoDayKey(lastCheckIn.getTime()) === yesterday;
    const canUseFreeze =
      !isConsecutiveDay && !!lastCheckIn && user.streakFreezes > 0;
    const newStreak =
      isConsecutiveDay || canUseFreeze ? user.streakCount + 1 : 1;
    const streakFreezes = canUseFreeze
      ? user.streakFreezes - 1
      : user.streakFreezes;
    const multiplier = Math.min(
      STREAK_MAX_MULTIPLIER,
      1 + Math.floor(newStreak / 7),
    );
    const coins = DAILY_CHECKIN_COINS * multiplier;

    // Two taps (or two devices) at the same moment: only the one that still
    // sees the old check-in time moves the streak, so the day pays once.
    const claimed = await this.prisma.user.updateMany({
      where: {
        id: userId,
        streakUpdatedAt: lastCheckIn ?? null,
      },
      data: {
        streakCount: newStreak,
        streakUpdatedAt: now,
        streakFreezes,
      },
    });
    if (claimed.count !== 1) {
      return {
        coins: 0,
        streak: user.streakCount,
        streakFreezes: user.streakFreezes,
        usedFreeze: false,
        alreadyCheckedIn: true,
      };
    }
    const outcome = await this.grants.grant({
      userId,
      amount: coins,
      reason: 'daily_checkin',
      refKey: `checkin:${today}`,
      dailyCapped: true,
    });

    await this.bumpQuestsForEvent(userId, 'checkin.daily');
    await this.achievements.setBest(userId, 'streak.best', newStreak);
    if (newStreak === 7) await this.awardBadgeIfExists(userId, 'week-streak');
    if (newStreak === 30) await this.awardBadgeIfExists(userId, 'iron-man');

    return {
      coins: outcome.status === 'paid' ? outcome.amount : 0,
      pendingCoins: outcome.status === 'pending' ? outcome.amount : 0,
      streak: newStreak,
      streakFreezes,
      usedFreeze: canUseFreeze,
      alreadyCheckedIn: false,
    };
  }

  async purchaseStreakFreeze(userId: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const spent = await tx.user.updateMany({
        where: { id: userId, coinsBalance: { gte: STREAK_FREEZE_COST_COINS } },
        data: {
          coinsBalance: { decrement: STREAK_FREEZE_COST_COINS },
          streakFreezes: { increment: 1 },
        },
      });
      if (spent.count !== 1) throw new BadRequestException('Not enough coins');
      await tx.coinLedgerEntry.create({
        data: {
          userId,
          amount: -STREAK_FREEZE_COST_COINS,
          reason: 'streak_freeze_purchase',
        },
      });
      return tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { coinsBalance: true, streakFreezes: true },
      });
    });
    return {
      coinsBalance: updated.coinsBalance,
      streakFreezes: updated.streakFreezes,
    };
  }

  async myQuests(userId: string) {
    const weekKey = isoWeekKey(new Date());
    const quests = await this.prisma.quest.findMany({
      where: { active: true },
    });
    const progress = await this.prisma.userQuestProgress.findMany({
      where: { userId, weekKey },
    });

    return quests.map((q) => {
      const p = progress.find((pr) => pr.questId === q.id);
      return {
        ...q,
        progress: p?.progress ?? 0,
        completedAt: p?.completedAt ?? null,
      };
    });
  }

  async bumpQuestProgress(userId: string, questKey: string, amount = 1) {
    const quest = await this.prisma.quest.findUnique({
      where: { key: questKey },
    });
    if (!quest || !quest.active) return;
    await this.bumpSingleQuest(userId, quest, amount);
  }

  async bumpQuestsForEvent(
    userId: string,
    event: QuestRule['event'],
    ctx: ActivityContext = {},
    amount = 1,
  ) {
    const quests = await this.prisma.quest.findMany({
      where: { active: true },
    });
    const matching = quests.filter((q) => {
      const rule = (q.rule as unknown as QuestRule) ?? { target: 1 };
      const questEvent = rule.event ?? 'booking.completed';
      return questEvent === event && this.questApplies(rule, ctx);
    });
    for (const quest of matching) {
      await this.bumpSingleQuest(userId, quest, amount);
    }
  }

  private questApplies(rule: QuestRule, ctx: ActivityContext): boolean {
    const scope = rule.scope;
    if (!scope) return true;
    if (scope.activityId && scope.activityId !== ctx.activityId) return false;
    if (scope.activityKind && scope.activityKind !== ctx.activityKind)
      return false;
    return true;
  }

  private async bumpSingleQuest(
    userId: string,
    quest: { id: string; key: string; rule: unknown; rewardCoins: number },
    amount: number,
  ) {
    const weekKey = isoWeekKey(new Date());
    const target = (quest.rule as QuestRule)?.target ?? 1;
    const existing = await this.prisma.userQuestProgress.findUnique({
      where: { userId_questId_weekKey: { userId, questId: quest.id, weekKey } },
    });
    if (existing?.completedAt) return;

    const newProgress = (existing?.progress ?? 0) + amount;
    const completed = newProgress >= target;

    await this.prisma.userQuestProgress.upsert({
      where: { userId_questId_weekKey: { userId, questId: quest.id, weekKey } },
      update: {
        progress: newProgress,
        completedAt: completed ? new Date() : undefined,
      },
      create: {
        userId,
        questId: quest.id,
        weekKey,
        progress: newProgress,
        target,
        completedAt: completed ? new Date() : undefined,
      },
    });

    if (completed) {
      // One reward per quest per week, however many requests finish it at once.
      await this.grants.grant({
        userId,
        amount: quest.rewardCoins,
        reason: `quest:${quest.key}`,
        refKey: `quest:${quest.key}:${weekKey}`,
      });
    }
  }

  listQuestDefinitions() {
    return this.prisma.quest.findMany({ orderBy: { createdAt: 'desc' } });
  }

  updateQuest(id: string, dto: UpdateQuestDto) {
    return this.prisma.quest.update({
      where: { id },
      data: { ...dto, rule: dto.rule as any },
    });
  }

  async myBadges(userId: string) {
    const rows = await this.prisma.userBadge.findMany({
      where: { userId },
      include: { badge: true },
    });
    return rows.map((row) => ({
      ...row,
      badge: {
        ...row.badge,
        iconKey: row.badge.iconKey ?? row.badge.icon,
      },
    }));
  }

  async awardBadge(userId: string, badgeKey: string) {
    const badge = await this.prisma.badge.findUniqueOrThrow({
      where: { key: badgeKey },
    });
    return this.prisma.userBadge.upsert({
      where: { userId_badgeId: { userId, badgeId: badge.id } },
      update: {},
      create: { userId, badgeId: badge.id },
    });
  }

  async awardBadgeIfExists(userId: string, badgeKey: string) {
    const badge = await this.prisma.badge.findUnique({
      where: { key: badgeKey },
    });
    if (!badge) return;
    await this.prisma.userBadge.upsert({
      where: { userId_badgeId: { userId, badgeId: badge.id } },
      update: {},
      create: { userId, badgeId: badge.id },
    });
  }

  listBadgeDefinitions() {
    return this.prisma.badge.findMany({ orderBy: { key: 'asc' } });
  }

  updateBadge(id: string, dto: UpdateBadgeDto) {
    return this.prisma.badge.update({ where: { id }, data: dto });
  }

  async leaderboard(
    sportId?: string,
    scope: 'weekly' | 'monthly' = 'weekly',
    districtId?: string,
    friendsUserId?: string,
  ) {
    const since = new Date(
      Date.now() - (scope === 'weekly' ? 7 : 30) * 86_400_000,
    );
    if (sportId) {
      const sport = await this.prisma.sportCategory.findFirst({
        where: {
          OR: [{ id: sportId }, { slug: sportId }, { id: `sport-${sportId}` }],
        },
      });
      sportId = sport?.id;
    }

    let friendIds: string[] | undefined;
    if (friendsUserId) {
      const friendships = await this.prisma.friendship.findMany({
        where: {
          status: 'accepted',
          OR: [{ requesterId: friendsUserId }, { addresseeId: friendsUserId }],
        },
        select: { requesterId: true, addresseeId: true },
      });
      friendIds = [
        friendsUserId,
        ...friendships.map((f) =>
          f.requesterId === friendsUserId ? f.addresseeId : f.requesterId,
        ),
      ];
    }

    if (!sportId) {
      const users = await this.prisma.user.findMany({
        where: {
          roles: { has: 'player' },
          status: 'active',
          isGuest: false,
          ...(friendIds ? { id: { in: friendIds } } : {}),
        },
        orderBy: [{ matchesPlayed: 'desc' }, { reputation: 'desc' }],
        take: 50,
        select: {
          id: true,
          name: true,
          avatarUrl: true,
          matchesPlayed: true,
          streakCount: true,
          reputation: true,
          mvps: true,
        },
      });
      return users.map((u, i) => ({
        rank: i + 1,
        userId: u.id,
        name: u.name,
        avatarUrl: u.avatarUrl,
        matchesPlayed: u.matchesPlayed,
        streak: u.streakCount,
        reputation: u.reputation,
        mvps: u.mvps,
      }));
    }
    const skills = await this.prisma.userSportSkill.findMany({
      where: {
        sportId,
        user: {
          ...(friendIds ? { id: { in: friendIds } } : {}),
          bookings: {
            some: {
              status: 'completed',
              slotStart: { gte: since },
              ...(districtId ? { venue: { districtId } } : {}),
            },
          },
        },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
            matchesPlayed: true,
            streakCount: true,
            reputation: true,
          },
        },
      },
      orderBy: { eloScore: 'desc' },
      take: 50,
    });
    return skills.map((s, i) => ({
      rank: i + 1,
      userId: s.user.id,
      name: s.user.name,
      avatarUrl: s.user.avatarUrl,
      matchesPlayed: s.user.matchesPlayed,
      streak: s.user.streakCount,
      reputation: s.user.reputation,
      tier: s.tier,
      eloScore: s.eloScore,
    }));
  }

  async createPromoCode(
    createdById: string,
    dto: CreatePromoCodeDto,
    isAdmin: boolean,
  ) {
    if (!isAdmin && !dto.venueId)
      throw new BadRequestException('Owners must scope promotions to a venue');
    if (dto.validFrom && dto.validUntil && dto.validFrom >= dto.validUntil) {
      throw new BadRequestException('validUntil must be after validFrom');
    }
    if (dto.type === 'percentage' && dto.value > 100) {
      throw new BadRequestException('Percentage value cannot exceed 100');
    }
    if (dto.venueId && !isAdmin) {
      const venue = await this.prisma.venue.findUnique({
        where: { id: dto.venueId },
      });
      if (!venue || venue.ownerId !== createdById) {
        throw new ForbiddenException('Not your venue');
      }
    }
    return this.prisma.promoCode.create({
      data: {
        ...dto,
        validFrom: new Date(dto.validFrom),
        validUntil: new Date(dto.validUntil),
        createdById,
      },
    });
  }

  async listPromoCodes(userId: string, isAdmin: boolean, venueId?: string) {
    if (venueId && !isAdmin) {
      const venue = await this.prisma.venue.findUnique({
        where: { id: venueId },
      });
      if (!venue || venue.ownerId !== userId) {
        throw new ForbiddenException('Not your venue');
      }
    }
    return this.prisma.promoCode.findMany({
      where: {
        ...(venueId ? { venueId } : isAdmin ? {} : { createdById: userId }),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async setPromoActive(
    id: string,
    userId: string,
    isAdmin: boolean,
    active: boolean,
  ) {
    return this.updatePromoCode(id, userId, isAdmin, { active });
  }

  async updatePromoCode(
    id: string,
    userId: string,
    isAdmin: boolean,
    dto: UpdatePromoCodeDto,
  ) {
    const promo = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!promo) throw new NotFoundException('Promo code not found');
    if (!isAdmin && promo.createdById !== userId) {
      if (!promo.venueId) {
        throw new ForbiddenException('Not your promo code');
      }
      const venue = await this.prisma.venue.findUnique({
        where: { id: promo.venueId },
      });
      if (!venue || venue.ownerId !== userId) {
        throw new ForbiddenException('Not your promo code');
      }
    }
    if (dto.venueId && !isAdmin) {
      const venue = await this.prisma.venue.findUnique({
        where: { id: dto.venueId },
      });
      if (!venue || venue.ownerId !== userId)
        throw new ForbiddenException('Not your venue');
    }
    const validFrom = dto.validFrom ? new Date(dto.validFrom) : promo.validFrom;
    const validUntil = dto.validUntil
      ? new Date(dto.validUntil)
      : promo.validUntil;
    if (validUntil <= validFrom)
      throw new BadRequestException('validUntil must be after validFrom');
    if (
      (dto.type ?? promo.type) === 'percentage' &&
      (dto.value ?? promo.value) > 100
    )
      throw new BadRequestException('Percentage value cannot exceed 100');
    return this.prisma.promoCode.update({
      where: { id },
      data: { ...dto, validFrom, validUntil },
    });
  }

  async deactivatePromoCode(id: string, userId: string, isAdmin: boolean) {
    await this.setPromoActive(id, userId, isAdmin, false);
    return this.prisma.promoCode.update({
      where: { id },
      data: { validUntil: new Date(), active: false },
    });
  }

  createQuest(dto: CreateQuestDto) {
    return this.prisma.quest.create({
      data: { ...dto, rule: dto.rule as any },
    });
  }

  createBadgeDef(dto: CreateBadgeDto) {
    return this.prisma.badge.create({ data: dto });
  }

  async getPlatformSetting() {
    return this.prisma.platformSetting.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });
  }

  updatePlatformSetting(dto: UpdatePlatformSettingDto) {
    return this.prisma.platformSetting.upsert({
      where: { id: 1 },
      update: dto,
      create: { id: 1, ...dto },
    });
  }

  /** Coins for a finished booking: only for one that proves a real player, within the budgets. */
  async payBookingCoins(params: {
    bookingId: string;
    userId: string;
    venueId: string;
    coins: number;
    firstBonus: number;
  }): Promise<void> {
    const q = await this.qualification.assess(params.bookingId);
    if (!q.ok) return;
    if (params.coins > 0)
      await this.grants.grant({
        userId: params.userId,
        amount: params.coins,
        reason: 'booking_completed',
        refKey: `booking:${params.bookingId}`,
        category: 'booking',
        venueId: params.venueId,
        bookingId: params.bookingId,
      });
    if (params.firstBonus > 0)
      await this.grants.grant({
        userId: params.userId,
        amount: params.firstBonus,
        reason: 'first_booking_bonus',
        refKey: 'first_booking',
        category: 'booking',
        venueId: params.venueId,
        bookingId: params.bookingId,
      });
  }

  async onBookingCompleted(params: {
    bookingId: string;
    userId: string;
    courtId: string;
    isFirstBooking: boolean;
    /** Kept for callers; the booking itself is re-read and judged. */
    totalAmount?: number;
    source?: string;
  }) {
    const q = await this.qualification.assess(params.bookingId);
    if (!q.ok) return;
    if (params.isFirstBooking) {
      await this.awardBadgeIfExists(params.userId, 'first-timer');
    }
    // The booking proves a real player: start (or finish) their trust, and
    // count it toward quests and achievements, a few a day at most.
    await this.trust.considerCheckIn(params.userId, params.bookingId, q);
    const counted = await this.achievements.bump(params.userId, 'booking.completed');
    if (counted <= 0) return;
    const court = await this.prisma.court.findUnique({
      where: { id: params.courtId },
      include: { sport: true },
    });
    const ctx: ActivityContext = {
      activityId: court?.sportId,
      activityKind: court?.sport.activityKind,
    };
    await this.bumpQuestsForEvent(params.userId, 'booking.completed', ctx);
  }

  private async settleReferralIfAny(userId: string, bookingId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referredById: true },
    });
    if (!user?.referredById || user.referredById === userId) return;
    const referrerId = user.referredById;
    // Two accounts on one phone are one person: no reward for inviting yourself.
    if (await this.links.areLinked(referrerId, userId)) return;

    // The new player is paid for the first paid booking; the inviter only
    // for a limited number of friends a month, and both after a hold.
    await this.grants.grant({
      userId,
      amount: REFERRAL_BONUS_COINS,
      reason: 'referral_bonus',
      refKey: 'referral:joined',
      holdMs: REFERRAL_HOLD_MS,
      bookingId,
    });
    const recent = await this.prisma.coinGrant.count({
      where: {
        userId: referrerId,
        refKey: { startsWith: 'referral:invited:' },
        createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
      },
    });
    if (recent < REFERRAL_MONTHLY_CAP) {
      await this.grants.grant({
        userId: referrerId,
        amount: REFERRAL_BONUS_COINS,
        reason: 'referral_bonus',
        refKey: `referral:invited:${userId}`,
        holdMs: REFERRAL_HOLD_MS,
        bookingId,
      });
    }
    await this.bumpQuestsForEvent(referrerId, 'referral.completed');
  }

  async onMvpAwarded(userId: string, newMvpCount: number, verified = true) {
    await this.bumpQuestsForEvent(userId, 'match.mvp.awarded');
    if (verified) await this.achievements.bump(userId, 'mvp.awarded');
    if (newMvpCount >= 5) await this.awardBadgeIfExists(userId, 'mvp-x5');
  }

  async onReviewSubmitted(
    userId: string,
    hasPhoto: boolean,
    bookingId: string,
  ) {
    // Only a review of a booking that proves a real player earns anything.
    if (!(await this.qualification.assess(bookingId)).ok) return;
    await this.bumpQuestsForEvent(userId, 'review.submitted');
    if (!hasPhoto) return;
    await this.bumpQuestsForEvent(userId, 'review.photo');
    await this.achievements.bump(userId, 'review.photo');
    await this.grants.grant({
      userId,
      amount: REVIEW_PHOTO_BONUS_COINS,
      reason: 'review_with_photo',
      refKey: `review_photo:${bookingId}`,
      bookingId,
    });
  }
}
