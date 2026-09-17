import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient | PrismaClient | PrismaService;

@Injectable()
export class HashtagService {
  constructor(private readonly prisma: PrismaService) {}

  async bumpTags(tx: Tx, tags: string[], delta: number) {
    for (const tag of tags) {
      const normalized = tag.replace(/^#/, '').toLowerCase();
      if (!normalized) continue;
      await tx.hashtag.upsert({
        where: { tag: normalized },
        update: { postCount: { increment: delta } },
        create: { tag: normalized, postCount: Math.max(delta, 0) },
      });
    }
  }

  async trending(limit = 12) {
    return this.prisma.hashtag.findMany({
      where: { postCount: { gt: 0 } },
      orderBy: [{ trendingScore: 'desc' }, { postCount: 'desc' }],
      take: limit,
    });
  }

  async refreshTrendingScores() {
    const since = new Date(Date.now() - 48 * 60 * 60_000);
    const recent = await this.prisma.post.findMany({
      where: { status: 'active', createdAt: { gte: since } },
      select: { hashtags: true, likeCount: true, commentCount: true, createdAt: true },
    });
    const scores = new Map<string, number>();
    for (const post of recent) {
      const hours = Math.max((Date.now() - post.createdAt.getTime()) / 3_600_000, 0.5);
      const velocity = (1 + post.likeCount + post.commentCount) / hours;
      for (const tag of post.hashtags) {
        scores.set(tag, (scores.get(tag) ?? 0) + velocity);
      }
    }
    const all = await this.prisma.hashtag.findMany({ select: { tag: true } });
    for (const row of all) {
      await this.prisma.hashtag.update({
        where: { tag: row.tag },
        data: { trendingScore: scores.get(row.tag) ?? 0 },
      });
    }
  }
}
