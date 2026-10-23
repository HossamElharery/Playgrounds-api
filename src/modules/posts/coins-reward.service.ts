import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { withJobLock } from '../../common/utils/job-lock.util';
import { PrismaService } from '../prisma/prisma.service';
import { CoinGrantService } from '../rewards/coin-grant.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from './analytics.service';
import { HashtagService } from './hashtag.service';

const LIKE_VELOCITY_CAP_PER_MINUTE = 25;

@Injectable()
export class CoinsRewardService {
  private readonly logger = new Logger(CoinsRewardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
    private readonly hashtags: HashtagService,
    private readonly grants: CoinGrantService,
  ) {}

  @Cron('*/12 * * * *')
  async tick() {
    try {
      // With several replicas every @Cron fires everywhere; one runs it.
      await withJobLock(this.prisma, 'coinsRewardTick', async () => {
        await this.hashtags.refreshTrendingScores();
        await this.evaluate();
      });
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
        // Claim the post first: a second runner that lost the race pays nothing.
        const claimed = await this.prisma.post.updateMany({
          where: { id: post.id, coinsAwarded: false },
          data: { coinsAwarded: true },
        });
        if (claimed.count !== 1) continue;
        const outcome = await this.grants.grant({
          userId: post.authorId,
          amount: rule.coinsAwarded,
          reason: 'post_engagement_reward',
          refKey: `post:${post.id}`,
        });
        if (outcome.status === 'void' || outcome.status === 'duplicate') continue;
        await this.notifications.create({
          userId: post.authorId,
          category: 'rewards',
          titleEn: 'You earned coins on a post',
          titleAr: 'كسبت كوينز على بوست',
          bodyEn:
            outcome.status === 'paid'
              ? `+${rule.coinsAwarded} coins`
              : `${rule.coinsAwarded} coins will be added after your first booking at a venue`,
          bodyAr:
            outcome.status === 'paid'
              ? `+${rule.coinsAwarded} كوينز`
              : `${rule.coinsAwarded} كوينز هتتضاف بعد أول حجز ليك في ملعب`,
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
    const cutoff = new Date(Date.now() - 72 * 60 * 60_000);
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true },
    });
    const likes = await this.prisma.postLike.findMany({
      where: {
        postId,
        userId: { not: post?.authorId },
        user: { createdAt: { lte: cutoff }, isGuest: false, status: 'active' },
      },
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
