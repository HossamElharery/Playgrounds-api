import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CoinGrantService } from './coin-grant.service';
import { cairoDayKey, metricDailyMax, metricLifetimeMax } from './coins-policy';
import type { CreateAchievementDto } from './dto/create-achievement.dto';
import type { UpdateAchievementDto } from './dto/update-achievement.dto';

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: string })?.code === 'P2002';

/**
 * Lifetime prizes. Game and match code only ever says "this player did X"
 * (`bump`); the prize rows, targets and coin amounts are admin data. A prize
 * is paid once per player, through CoinGrantService, so it waits until the
 * player is a real, trusted one.
 */
@Injectable()
export class AchievementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: CoinGrantService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Adds to a counter (respecting the per-day cap of that metric) and
   * completes every achievement the new value reaches. Returns how much was
   * actually counted. Never throws: a rewards problem must not break a game.
   */
  async bump(userId: string, metric: string, amount = 1): Promise<number> {
    try {
      const counted = await this.addToMetric(userId, metric, amount);
      if (counted.added > 0) await this.evaluate(userId, metric, counted.value);
      return counted.added;
    } catch {
      return 0;
    }
  }

  /** Keeps the best value seen (streaks). */
  async setBest(userId: string, metric: string, value: number): Promise<void> {
    try {
      const row = await this.prisma.userMetric.findUnique({
        where: { userId_metric: { userId, metric } },
      });
      if (row && row.value >= value) return;
      await this.prisma.userMetric.upsert({
        where: { userId_metric: { userId, metric } },
        create: { userId, metric, value },
        update: { value },
      });
      await this.evaluate(userId, metric, value);
    } catch {
      /* best effort */
    }
  }

  private async addToMetric(
    userId: string,
    metric: string,
    amount: number,
  ): Promise<{ added: number; value: number }> {
    const today = cairoDayKey();
    const max = metricDailyMax(metric);
    const lifetimeMax = metricLifetimeMax(metric);
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await this.prisma.userMetric.findUnique({
        where: { userId_metric: { userId, metric } },
      });
      const dayCount = row && row.dayKey === today ? row.dayCount : 0;
      let added =
        max == null ? amount : Math.max(0, Math.min(amount, max - dayCount));
      if (lifetimeMax != null)
        added = Math.max(0, Math.min(added, lifetimeMax - (row?.value ?? 0)));
      if (added <= 0) return { added: 0, value: row?.value ?? 0 };
      if (!row) {
        try {
          await this.prisma.userMetric.create({
            data: { userId, metric, value: added, dayKey: today, dayCount: added },
          });
          return { added, value: added };
        } catch (error) {
          if (isUniqueViolation(error)) continue;
          throw error;
        }
      }
      const changed = await this.prisma.userMetric.updateMany({
        where: { id: row.id, updatedAt: row.updatedAt },
        data: {
          value: { increment: added },
          dayKey: today,
          dayCount: dayCount + added,
        },
      });
      if (changed.count === 1) return { added, value: row.value + added };
    }
    return { added: 0, value: 0 };
  }

  private async evaluate(
    userId: string,
    metric: string,
    value: number,
  ): Promise<void> {
    const reached = await this.prisma.achievement.findMany({
      where: { metric, active: true, target: { lte: value } },
      orderBy: { target: 'asc' },
    });
    for (const a of reached) {
      try {
        await this.prisma.userAchievement.create({
          data: { userId, achievementId: a.id },
        });
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
      const outcome = await this.grants.grant({
        userId,
        amount: a.rewardCoins,
        reason: `achievement:${a.key}`,
        refKey: `ach:${a.key}`,
      });
      const paid = outcome.status === 'paid';
      await this.notifications
        .create({
          userId,
          category: 'rewards',
          titleEn: `Achievement unlocked: ${a.titleEn}`,
          titleAr: `إنجاز جديد: ${a.titleAr}`,
          bodyEn: paid
            ? `+${a.rewardCoins} coins`
            : `${a.rewardCoins} coins will be added after your first booking at a venue`,
          bodyAr: paid
            ? `+${a.rewardCoins} كوينز`
            : `${a.rewardCoins} كوينز هتتضاف بعد أول حجز ليك في ملعب`,
          deepLink: '/app/wallet',
          payload: { achievement: a.key, coins: a.rewardCoins },
          dedupKey: `achievement:${userId}:${a.key}`,
        })
        .catch(() => undefined);
    }
  }

  /** Everything the wallet's achievements section shows. */
  async listForUser(userId: string) {
    const defs = await this.prisma.achievement.findMany({
      where: { active: true },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
    });
    const metrics = [...new Set(defs.map((d) => d.metric))];
    const [values, done, grants] = await Promise.all([
      this.prisma.userMetric.findMany({
        where: { userId, metric: { in: metrics } },
        select: { metric: true, value: true },
      }),
      this.prisma.userAchievement.findMany({
        where: { userId },
        select: { achievementId: true, completedAt: true },
      }),
      this.prisma.coinGrant.findMany({
        where: { userId, refKey: { startsWith: 'ach:' } },
        select: { refKey: true, status: true },
      }),
    ]);
    const valueOf = new Map(values.map((v) => [v.metric, v.value]));
    const doneAt = new Map(done.map((d) => [d.achievementId, d.completedAt]));
    const grantOf = new Map(grants.map((g) => [g.refKey, g.status]));
    return defs.map((d) => {
      const completedAt = doneAt.get(d.id) ?? null;
      return {
        key: d.key,
        category: d.category,
        icon: d.icon,
        titleEn: d.titleEn,
        titleAr: d.titleAr,
        descEn: d.descEn,
        descAr: d.descAr,
        target: d.target,
        rewardCoins: d.rewardCoins,
        progress: Math.min(d.target, valueOf.get(d.metric) ?? 0),
        completedAt,
        rewardStatus: completedAt ? (grantOf.get(`ach:${d.key}`) ?? 'pending') : null,
      };
    });
  }

  listDefinitions() {
    return this.prisma.achievement.findMany({
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  createDefinition(dto: CreateAchievementDto) {
    return this.prisma.achievement.create({ data: dto });
  }

  async updateDefinition(id: string, dto: UpdateAchievementDto) {
    const found = await this.prisma.achievement.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('Achievement not found');
    return this.prisma.achievement.update({ where: { id }, data: dto });
  }
}
