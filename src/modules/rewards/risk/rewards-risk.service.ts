import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { withJobLock } from '../../../common/utils/job-lock.util';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { VENUE_DAILY_COIN_BUDGET, VENUE_NEW_TRUST_PER_WEEK } from '../coins-policy';

export interface RiskVenueRow {
  venueId: string;
  name: string;
  newTrusted7d: number;
  coins24h: number;
  frozen: boolean;
}

export interface RiskClusterRow {
  deviceHash: string;
  users: { id: string; name: string; trusted: boolean }[];
}

/** What the admin looks at to catch fake bookings and fake accounts, and the alert that tells them to look. */
@Injectable()
export class RewardsRiskService {
  private readonly logger = new Logger(RewardsRiskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async venues(limit = 30): Promise<RiskVenueRow[]> {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const dayAgo = new Date(Date.now() - 86_400_000);
    const [trusted, coins] = await Promise.all([
      this.prisma.user.groupBy({
        by: ['trustVenueId'],
        where: { trustVenueId: { not: null }, trustCandidateAt: { gte: weekAgo } },
        _count: { _all: true },
      }),
      this.prisma.coinGrant.groupBy({
        by: ['venueId'],
        where: { venueId: { not: null }, category: 'booking', status: 'paid', paidAt: { gte: dayAgo } },
        _sum: { amount: true },
      }),
    ]);
    const frozen = await this.prisma.venue.findMany({
      where: { rewardsFrozenAt: { not: null } },
      select: { id: true },
    });
    const ids = new Set<string>([
      ...trusted.map((t) => t.trustVenueId as string),
      ...coins.map((c) => c.venueId as string),
      ...frozen.map((f) => f.id),
    ]);
    if (!ids.size) return [];
    const names = await this.prisma.venue.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, nameEn: true, nameAr: true, rewardsFrozenAt: true },
    });
    const rows = names.map<RiskVenueRow>((v) => ({
      venueId: v.id,
      name: v.nameAr || v.nameEn,
      newTrusted7d: trusted.find((t) => t.trustVenueId === v.id)?._count._all ?? 0,
      coins24h: coins.find((c) => c.venueId === v.id)?._sum.amount ?? 0,
      frozen: !!v.rewardsFrozenAt,
    }));
    return rows
      .sort((a, b) => b.newTrusted7d - a.newTrusted7d || b.coins24h - a.coins24h)
      .slice(0, limit);
  }

  /** Devices used by more than one account (a person with several accounts). */
  async clusters(limit = 20): Promise<RiskClusterRow[]> {
    const shared = await this.prisma.userDevice.groupBy({
      by: ['deviceHash'],
      _count: { userId: true },
      having: { userId: { _count: { gt: 1 } } },
      orderBy: { _count: { userId: 'desc' } },
      take: limit,
    });
    if (!shared.length) return [];
    const rows = await this.prisma.userDevice.findMany({
      where: { deviceHash: { in: shared.map((s) => s.deviceHash) } },
      select: { deviceHash: true, user: { select: { id: true, name: true, trustedAt: true } } },
    });
    return shared.map((s) => ({
      deviceHash: s.deviceHash,
      users: rows
        .filter((r) => r.deviceHash === s.deviceHash)
        .map((r) => ({ id: r.user.id, name: r.user.name, trusted: !!r.user.trustedAt })),
    }));
  }

  async overview() {
    const [venues, clusters, blocked, candidates] = await Promise.all([
      this.venues(),
      this.clusters(),
      this.prisma.user.count({ where: { rewardsBlockedAt: { not: null } } }),
      this.prisma.user.count({ where: { trustedAt: null, trustCandidateAt: { not: null } } }),
    ]);
    return { venues, clusters, blockedUsers: blocked, trustCandidates: candidates };
  }

  /** Daily: tell every admin when a venue or a device looks like a farm. */
  @Cron('0 7 * * *')
  async alertAdmins(): Promise<void> {
    try {
      await withJobLock(this.prisma, 'rewardsRiskAlert', async () => {
        await this.alertNow();
      });
    } catch (err) {
      this.logger.warn(`risk alert skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  async alertNow(): Promise<{ venues: number; clusters: number }> {
    const [venues, clusters] = await Promise.all([this.venues(50), this.clusters(50)]);
    const hot = venues.filter(
      (v) =>
        !v.frozen &&
        (v.newTrusted7d >= Math.ceil(VENUE_NEW_TRUST_PER_WEEK * 0.75) ||
          v.coins24h >= VENUE_DAILY_COIN_BUDGET * 0.7),
    );
    const trustedClusters = clusters.filter((c) => c.users.filter((u) => u.trusted).length > 1);
    if (!hot.length && !trustedClusters.length) return { venues: 0, clusters: 0 };
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: 'admin' }, status: 'active' },
      select: { id: true },
    });
    const day = new Date().toISOString().slice(0, 10);
    const names = hot.slice(0, 3).map((v) => v.name).join('، ');
    for (const a of admins) {
      await this.notifications
        .create({
          userId: a.id,
          category: 'system',
          titleEn: 'Rewards: review possible fake activity',
          titleAr: 'المكافآت: راجع نشاط مشبوه محتمل',
          bodyEn: `${hot.length} venue(s) near the new-player or coin limit, ${trustedClusters.length} shared device(s) with several trusted accounts.`,
          bodyAr: `${hot.length} ملعب قرّب من حد اللاعبين الجدد أو الكوينز${names ? ` (${names})` : ''}، و${trustedClusters.length} جهاز مشترك بين أكتر من حساب موثوق.`,
          deepLink: '/admin/rewards',
          dedupKey: `rewards-risk:${day}:${a.id}`,
        })
        .catch(() => undefined);
    }
    return { venues: hot.length, clusters: trustedClusters.length };
  }
}
