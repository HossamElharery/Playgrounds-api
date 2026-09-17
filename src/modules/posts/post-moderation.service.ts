import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';
import { PostsService } from './posts.service';
import {
  SuspendPostingDto,
  UpdateCoinsRuleDto,
  UpdateModerationConfigDto,
} from './dto/moderation.dto';

@Injectable()
export class PostModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly posts: PostsService,
  ) {}

  async reports(status: 'open' | 'reviewed' | 'dismissed' | undefined, q: string | undefined, cursor?: string, limit = 30) {
    const take = Math.min(Math.max(limit, 1), 50);
    const where: Prisma.PostReportWhereInput = {};
    if (status) where.status = status;
    if (q?.trim()) {
      const query = q.trim();
      const id = this.extractId(query);
      where.OR = [
        ...(id ? [{ postId: id }, { id }] : []),
        { post: { author: { name: { contains: query, mode: 'insensitive' } } } },
      ];
    }
    const rows = await this.prisma.postReport.findMany({
      where,
      include: {
        reporter: { select: { id: true, name: true, avatarUrl: true } },
        post: {
          include: {
            author: { select: { id: true, name: true, username: true, avatarUrl: true, createdAt: true } },
            media: { orderBy: { order: 'asc' }, take: 1 },
            _count: { select: { reports: true, media: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, take);
    return {
      items: page.map((r) => ({
        id: r.id,
        postId: r.postId,
        reason: r.reason,
        note: r.note,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        reporter: r.reporter,
        reportCount: r.post._count.reports,
        excerpt: r.post.text.slice(0, 80),
        thumbnailUrl: r.post.media[0]?.thumbnailUrl,
        author: r.post.author,
        permalink: `${r.post.slug}-${r.post.id}`,
      })),
      nextCursor: rows.length > take ? page[page.length - 1].id : undefined,
    };
  }

  async lookup(query: string) {
    const id = this.extractId(query) || query.trim();
    const post = await this.prisma.post.findFirst({
      where: { OR: [{ id }, { slug: query.trim() }] },
    });
    if (!post) throw new NotFoundException('Post not found');
    return this.review(post.id);
  }

  async review(postId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            username: true,
            avatarUrl: true,
            createdAt: true,
            postingRestriction: true,
            _count: { select: { feedPosts: true } },
          },
        },
        media: { orderBy: { order: 'asc' } },
        reports: {
          include: { reporter: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
        taggedVenue: { select: { id: true, slug: true, nameEn: true, nameAr: true } },
      },
    });
    if (!post) throw new NotFoundException('Post not found');
    const prior = await this.prisma.moderationAction.findMany({
      where: { targetUserId: post.authorId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return {
      post: await this.posts.toDto(post as never),
      author: {
        ...post.author,
        accountAgeDays: Math.floor((Date.now() - post.author.createdAt.getTime()) / 86_400_000),
        totalPosts: post.author._count.feedPosts,
        restriction: post.author.postingRestriction,
      },
      reports: post.reports,
      priorActions: prior,
    };
  }

  async deletePost(adminId: string, postId: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('Reason is required');
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    await this.prisma.$transaction([
      this.prisma.post.update({
        where: { id: postId },
        data: {
          status: 'removed',
          removedReason: reason.trim(),
          removedByAdminId: adminId,
        },
      }),
      this.prisma.postReport.updateMany({
        where: { postId, status: 'open' },
        data: { status: 'reviewed', reviewedById: adminId },
      }),
      this.prisma.moderationAction.create({
        data: {
          type: 'post_deleted',
          targetPostId: postId,
          targetUserId: post.authorId,
          reason: reason.trim(),
          adminId,
        },
      }),
    ]);
    this.analytics.emit('post_moderation_action', adminId, { type: 'post_deleted', postId });
    return { ok: true };
  }

  async deleteComment(adminId: string, commentId: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('Reason is required');
    const comment = await this.prisma.postComment.findUnique({ where: { id: commentId } });
    if (!comment) throw new NotFoundException('Comment not found');
    await this.prisma.$transaction([
      this.prisma.postComment.update({
        where: { id: commentId },
        data: { status: 'removed', removedReason: reason.trim() },
      }),
      this.prisma.post.update({
        where: { id: comment.postId },
        data: { commentCount: { decrement: 1 } },
      }),
      this.prisma.moderationAction.create({
        data: {
          type: 'comment_deleted',
          targetCommentId: commentId,
          targetPostId: comment.postId,
          targetUserId: comment.authorId,
          reason: reason.trim(),
          adminId,
        },
      }),
    ]);
    this.analytics.emit('post_moderation_action', adminId, { type: 'comment_deleted', commentId });
    return { ok: true };
  }

  async dismiss(adminId: string, reportId: string, reason: string) {
    const report = await this.prisma.postReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found');
    await this.prisma.$transaction([
      this.prisma.postReport.update({
        where: { id: reportId },
        data: { status: 'dismissed', reviewedById: adminId },
      }),
      this.prisma.moderationAction.create({
        data: {
          type: 'report_dismissed',
          targetPostId: report.postId,
          reason: reason?.trim() || 'unfounded',
          adminId,
        },
      }),
    ]);
    this.analytics.emit('post_moderation_action', adminId, { type: 'report_dismissed', reportId });
    return { ok: true };
  }

  async suspend(adminId: string, userId: string, dto: SuspendPostingDto) {
    if (!dto.reason?.trim()) throw new BadRequestException('Reason is required');
    const until =
      dto.permanent || !dto.durationDays
        ? null
        : new Date(Date.now() + dto.durationDays * 86_400_000);
    await this.prisma.$transaction([
      this.prisma.userPostingRestriction.upsert({
        where: { userId },
        update: {
          suspendedUntil: until,
          permanent: dto.permanent,
          reason: dto.reason.trim(),
          issuedByAdminId: adminId,
          issuedAt: new Date(),
        },
        create: {
          userId,
          suspendedUntil: until,
          permanent: dto.permanent,
          reason: dto.reason.trim(),
          issuedByAdminId: adminId,
        },
      }),
      this.prisma.moderationAction.create({
        data: {
          type: 'user_posting_suspended',
          targetUserId: userId,
          reason: dto.reason.trim(),
          adminId,
        },
      }),
    ]);
    this.analytics.emit('post_moderation_action', adminId, { type: 'user_posting_suspended', userId });
    return { ok: true };
  }

  async unsuspend(adminId: string, userId: string, reason: string) {
    await this.prisma.$transaction([
      this.prisma.userPostingRestriction.deleteMany({ where: { userId } }),
      this.prisma.moderationAction.create({
        data: {
          type: 'user_posting_unsuspended',
          targetUserId: userId,
          reason: reason?.trim() || 'lifted',
          adminId,
        },
      }),
    ]);
    this.analytics.emit('post_moderation_action', adminId, { type: 'user_posting_unsuspended', userId });
    return { ok: true };
  }

  async auditLog(cursor?: string, limit = 40) {
    const take = Math.min(Math.max(limit, 1), 80);
    const rows = await this.prisma.moderationAction.findMany({
      include: { admin: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, take);
    return {
      items: page,
      nextCursor: rows.length > take ? page[page.length - 1].id : undefined,
    };
  }

  async coinsRules() {
    return this.prisma.coinsRewardRule.findMany({ orderBy: { updatedAt: 'desc' } });
  }

  async updateCoinsRule(adminId: string, id: string, dto: UpdateCoinsRuleDto) {
    return this.prisma.coinsRewardRule.update({
      where: { id },
      data: { ...dto, updatedByAdminId: adminId },
    });
  }

  async config() {
    const settings = await this.prisma.platformSetting.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });
    const rules = await this.coinsRules();
    return { autoHideReportThreshold: settings.autoHideReportThreshold, rules };
  }

  async updateConfig(dto: UpdateModerationConfigDto) {
    return this.prisma.platformSetting.upsert({
      where: { id: 1 },
      update: { autoHideReportThreshold: dto.autoHideReportThreshold },
      create: { id: 1, autoHideReportThreshold: dto.autoHideReportThreshold ?? 5 },
    });
  }

  private extractId(value: string): string | undefined {
    const uuid =
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(value);
    return uuid?.[0];
  }
}
