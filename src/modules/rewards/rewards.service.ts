import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePromoCodeDto } from './dto/create-promo-code.dto';
import { CreateQuestDto } from './dto/create-quest.dto';
import { CreateBadgeDto } from './dto/create-badge.dto';
import { UpdatePlatformSettingDto } from './dto/update-platform-setting.dto';

const DAILY_CHECKIN_COINS = 5;
const STREAK_MAX_MULTIPLIER = 3;

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

  // ---- Wallet ----
  async wallet(userId: string) {
    const [user, ledger] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { coinsBalance: true, streakCount: true },
      }),
      this.prisma.coinLedgerEntry.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    return { balance: user.coinsBalance, streak: user.streakCount, ledger };
  }

  async dailyCheckIn(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const now = new Date();
    const lastCheckIn = user.streakUpdatedAt;
    const isSameDay =
      lastCheckIn && lastCheckIn.toDateString() === now.toDateString();
    if (isSameDay) throw new BadRequestException('Already checked in today');

    const isConsecutiveDay =
      lastCheckIn && now.getTime() - lastCheckIn.getTime() < 48 * 3_600_000;
    const newStreak = isConsecutiveDay ? user.streakCount + 1 : 1;
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
        },
      }),
      this.prisma.coinLedgerEntry.create({
        data: { userId, amount: coins, reason: 'daily_checkin' },
      }),
    ]);
    return { coins, streak: newStreak };
  }

  // ---- Quests ----
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

    const weekKey = isoWeekKey(new Date());
    const target = (quest.rule as any)?.target ?? 1;
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

  // ---- Badges ----
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

  // ---- Leaderboards ----
  async leaderboard(
    sportId?: string,
    scope: 'weekly' | 'monthly' = 'weekly',
    districtId?: string,
  ) {
    const since = new Date(
      Date.now() - (scope === 'weekly' ? 7 : 30) * 86_400_000,
    );
    if (sportId) {
      const sport = await this.prisma.sportCategory.findFirst({
        where: { OR: [{ id: sportId }, { slug: sportId }, { id: `sport-${sportId}` }] },
      });
      sportId = sport?.id;
    }
    if (!sportId) {
      const users = await this.prisma.user.findMany({
        where: { roles: { has: 'player' }, status: 'active' },
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
          bookings: {
            some: {
              status: 'completed',
              slotStart: { gte: since },
              ...(districtId ? { venue: { districtId } } : {}),
            },
          },
        },
      },
      include: { user: { select: { id: true, name: true, avatarUrl: true, matchesPlayed: true, streakCount: true, reputation: true } } },
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

  // ---- Promo codes (admin/owner) ----
  async createPromoCode(
    createdById: string,
    dto: CreatePromoCodeDto,
    isAdmin: boolean,
  ) {
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

  async setPromoActive(id: string, userId: string, isAdmin: boolean, active: boolean) {
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
    return this.prisma.promoCode.update({
      where: { id },
      data: { active },
    });
  }

  async deactivatePromoCode(id: string, userId: string, isAdmin: boolean) {
    await this.setPromoActive(id, userId, isAdmin, false);
    return this.prisma.promoCode.update({
      where: { id },
      data: { validUntil: new Date(), active: false },
    });
  }

  // ---- Quest/badge admin CRUD ----
  createQuest(dto: CreateQuestDto) {
    return this.prisma.quest.create({
      data: { ...dto, rule: dto.rule as any },
    });
  }

  createBadgeDef(dto: CreateBadgeDto) {
    return this.prisma.badge.create({ data: dto });
  }

  // ---- Platform settings (admin) ----
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
}
