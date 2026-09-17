import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RewardsService } from '../rewards/rewards.service';
import { AnalyticsService } from './analytics.service';
import { HashtagService } from './hashtag.service';

const LIKE_VELOCITY_CAP_PER_MINUTE = 25;

@Injectable()
export class CoinsRewardService {
  private readonly logger = new Logger(CoinsRewardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rewards: RewardsService,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
    private readonly hashtags: HashtagService,
  ) {}

  @Cron('*/12 * * * *')
  async tick() {
    try {
      await this.hashtags.refreshTrendingScores();
      await this.evaluate();
    } catch (err) {
      this.logger.error('Coins/hashtag job failed', err as Error);
    }
  }

  async evaluate() {
    let rules = await this.prisma.coinsRewardRule.findMany({ where: { active: true } });
    if (!rules.length) {
      const admin = await this.prisma.user.findFirst({
        where: { roles: { has: 'admin' } },
        select: { id: true },
      });
      if (admin) {
        await this.prisma.coinsRewardRule.create({
          data: { updatedByAdminId: admin.id },
        });
        rules = await this.prisma.coinsRewardRule.findMany({ where: { active: true } });
      }
    }
    if (!rules.length) return { awarded: 0 };
    let awarded = 0;
    for (const rule of rules) {
      if (rule.metric !== 'like_count') continue;
      const candidates = await this.prisma.post.findMany({
        where: {
          coinsAwarded: false,
          authorKind: 'user',
          status: 'active',
          flagged: false,
          likeCount: { gte: rule.threshold },
        },
        select: {
          id: true,
          slug: true,
          authorId: true,
          likeCount: true,
          author: { select: { postingRestriction: true } },
        },
        take: 50,
      });
      for (const post of candidates) {
        if (post.author.postingRestriction?.permanent) continue;
        if (
          post.author.postingRestriction?.suspendedUntil &&
          post.author.postingRestriction.suspendedUntil > new Date()
        ) {
          continue;
        }
        const eligible = await this.eligibleLikeCount(post.id);
        if (eligible < rule.threshold) continue;
        const ok = await this.rewards.awardLedger(
          post.authorId,
          rule.coinsAwarded,
          'post_engagement_reward',
        );
        if (!ok) continue;
        await this.prisma.post.update({
          where: { id: post.id },
          data: { coinsAwarded: true },
        });
        await this.notifications.create({
          userId: post.authorId,
          category: 'rewards',
          titleEn: 'You earned coins on a post',
          titleAr: 'كسبت كوينز على بوست',
          bodyEn: `+${rule.coinsAwarded} coins`,
          bodyAr: `+${rule.coinsAwarded} كوينز`,
          deepLink: `/app/community/post/${post.slug}-${post.id}`,
          payload: { postId: post.id, coins: rule.coinsAwarded },
        });
        this.analytics.emit('coins_awarded_post', post.authorId, {
          postId: post.id,
          coins: rule.coinsAwarded,
        });
        awarded += 1;
      }
    }
    return { awarded };
  }

  private async eligibleLikeCount(postId: string): Promise<number> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    const likes = await this.prisma.postLike.findMany({
      where: { postId, user: { createdAt: { lte: cutoff } } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (likes.length < 2) return likes.length;
    let burst = 0;
    let windowStart = likes[0].createdAt.getTime();
    let windowCount = 0;
    for (const like of likes) {
      const t = like.createdAt.getTime();
      if (t - windowStart <= 60_000) {
        windowCount += 1;
      } else {
        windowStart = t;
        windowCount = 1;
      }
      burst = Math.max(burst, windowCount);
    }
    if (burst > LIKE_VELOCITY_CAP_PER_MINUTE) return 0;
    return likes.length;
  }
}
