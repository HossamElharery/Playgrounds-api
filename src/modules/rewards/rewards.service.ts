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

const DAILY_CHECKIN_COINS = 5;
const STREAK_MAX_MULTIPLIER = 3;
const STREAK_FREEZE_COST_COINS = 400;
const REFERRAL_BONUS_COINS = 300;
const REVIEW_PHOTO_BONUS_COINS = 50;

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
    | 'review.submitted';
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
  constructor(private readonly prisma: PrismaService) {}

  async wallet(userId: string) {
    const [user, ledger] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { coinsBalance: true, streakCount: true, streakFreezes: true },
      }),
      this.prisma.coinLedgerEntry.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    return {
      balance: user.coinsBalance,
      streak: user.streakCount,
      streakFreezes: user.streakFreezes,
      ledger,
    };
  }

  async dailyCheckIn(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const now = new Date();
    const lastCheckIn = user.streakUpdatedAt;
    const isSameDay =
      lastCheckIn && lastCheckIn.toDateString() === now.toDateString();
    if (isSameDay) {
      return {
        coins: 0,
        streak: user.streakCount,
        streakFreezes: user.streakFreezes,
        usedFreeze: false,
        alreadyCheckedIn: true,
      };
    }

    const isConsecutiveDay =
      lastCheckIn && now.getTime() - lastCheckIn.getTime() < 48 * 3_600_000;
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

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          coinsBalance: { increment: coins },
          streakCount: newStreak,
          streakUpdatedAt: now,
          streakFreezes,
        },
      }),
      this.prisma.coinLedgerEntry.create({
        data: { userId, amount: coins, reason: 'daily_checkin' },
      }),
    ]);

    await this.bumpQuestsForEvent(userId, 'checkin.daily');
    if (newStreak === 7) await this.awardBadgeIfExists(userId, 'week-streak');
    if (newStreak === 30) await this.awardBadgeIfExists(userId, 'iron-man');

    return {
      coins,
      streak: newStreak,
      streakFreezes,
      usedFreeze: canUseFreeze,
      alreadyCheckedIn: false,
    };
  }

  async purchaseStreakFreeze(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (user.coinsBalance < STREAK_FREEZE_COST_COINS) {
      throw new BadRequestException('Not enough coins');
    }
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          coinsBalance: { decrement: STREAK_FREEZE_COST_COINS },
          streakFreezes: { increment: 1 },
        },
      }),
      this.prisma.coinLedgerEntry.create({
        data: {
          userId,
          amount: -STREAK_FREEZE_COST_COINS,
          reason: 'streak_freeze_purchase',
        },
      }),
    ]);
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
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: userId },
          data: { coinsBalance: { increment: quest.rewardCoins } },
        }),
        this.prisma.coinLedgerEntry.create({
          data: {
            userId,
            amount: quest.rewardCoins,
            reason: `quest:${quest.key}`,
          },
        }),
      ]);
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

  async onBookingCompleted(params: {
    bookingId: string;
    userId: string;
    courtId: string;
    isFirstBooking: boolean;
  }) {
    const court = await this.prisma.court.findUnique({
      where: { id: params.courtId },
      include: { sport: true },
    });
    const ctx: ActivityContext = {
      activityId: court?.sportId,
      activityKind: court?.sport.activityKind,
    };
    await this.bumpQuestsForEvent(params.userId, 'booking.completed', ctx);
    if (params.isFirstBooking) {
      await this.awardBadgeIfExists(params.userId, 'first-timer');
      await this.settleReferralIfAny(params.userId, params.bookingId);
    }
  }

  private async settleReferralIfAny(userId: string, bookingId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referredById: true },
    });
    if (!user?.referredById) return;
    const referrerId = user.referredById;

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { coinsBalance: { increment: REFERRAL_BONUS_COINS } },
      }),
      this.prisma.coinLedgerEntry.create({
        data: {
          userId,
          amount: REFERRAL_BONUS_COINS,
          reason: 'referral_bonus',
          bookingId,
        },
      }),
      this.prisma.user.update({
        where: { id: referrerId },
        data: { coinsBalance: { increment: REFERRAL_BONUS_COINS } },
      }),
      this.prisma.coinLedgerEntry.create({
        data: {
          userId: referrerId,
          amount: REFERRAL_BONUS_COINS,
          reason: 'referral_bonus',
          bookingId,
        },
      }),
    ]);
    await this.bumpQuestsForEvent(referrerId, 'referral.completed');
  }

  async onMvpAwarded(userId: string, newMvpCount: number) {
    await this.bumpQuestsForEvent(userId, 'match.mvp.awarded');
    if (newMvpCount >= 5) await this.awardBadgeIfExists(userId, 'mvp-x5');
  }

  async onReviewSubmitted(
    userId: string,
    hasPhoto: boolean,
    bookingId: string,
  ) {
    await this.bumpQuestsForEvent(userId, 'review.submitted');
    if (!hasPhoto) return;
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { coinsBalance: { increment: REVIEW_PHOTO_BONUS_COINS } },
      }),
      this.prisma.coinLedgerEntry.create({
        data: {
          userId,
          amount: REVIEW_PHOTO_BONUS_COINS,
          reason: 'review_with_photo',
          bookingId,
        },
      }),
    ]);
  }
}
