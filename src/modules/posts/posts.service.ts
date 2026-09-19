import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PostAuthorKind,
  PostReportReason,
  PostStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from './analytics.service';
import { HashtagService } from './hashtag.service';
import { CreatePostDto } from './dto/create-post.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CreatePostReportDto } from './dto/create-report.dto';
import {
  containsBlockedLanguage,
  extractHashtags,
  extractMentionTokens,
} from './profanity.util';
import { parsePermalinkParam, slugifyPost } from './posts-slug.util';

const MAX_POST_TEXT = 2200;
const POSTS_PER_HOUR = 10;
const LIKES_PER_MINUTE = 40;
const REPORTS_PER_DAY = 20;
const AUTHOR_SELECT = {
  id: true,
  name: true,
  username: true,
  avatarUrl: true,
} as const;

export type PostViewer = { id: string; roles?: string[] } | undefined;

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
    private readonly hashtags: HashtagService,
  ) {}

  async assertCanPost(userId: string) {
    const restriction = await this.prisma.userPostingRestriction.findUnique({
      where: { userId },
    });
    if (!restriction) return;
    if (restriction.permanent) {
      throw new ForbiddenException({
        code: 'posting_suspended',
        reason: restriction.reason,
        permanent: true,
      });
    }
    if (restriction.suspendedUntil && restriction.suspendedUntil > new Date()) {
      throw new ForbiddenException({
        code: 'posting_suspended',
        reason: restriction.reason,
        until: restriction.suspendedUntil.toISOString(),
      });
    }
  }

  async postingStatus(userId: string) {
    const restriction = await this.prisma.userPostingRestriction.findUnique({
      where: { userId },
    });
    if (!restriction) return { restricted: false };
    if (restriction.permanent) {
      return { restricted: true, permanent: true, reason: restriction.reason };
    }
    if (restriction.suspendedUntil && restriction.suspendedUntil > new Date()) {
      return {
        restricted: true,
        permanent: false,
        reason: restriction.reason,
        until: restriction.suspendedUntil.toISOString(),
      };
    }
    return { restricted: false };
  }

  async create(userId: string, dto: CreatePostDto, isAdmin: boolean) {
    await this.assertCanPost(userId);
    const recent = await this.prisma.post.count({
      where: { authorId: userId, createdAt: { gte: new Date(Date.now() - 60 * 60_000) } },
    });
    if (recent >= POSTS_PER_HOUR) {
      throw new ForbiddenException('Posting rate limit reached');
    }

    const text = (dto.text ?? '').trim();
    const assetIds = dto.mediaAssetIds ?? [];
    if (!text && !assetIds.length) {
      throw new BadRequestException('Post needs text or media');
    }
    if (text.length > MAX_POST_TEXT) {
      throw new BadRequestException('Post text is too long');
    }

    const assets = assetIds.length
      ? await this.prisma.mediaAsset.findMany({
          where: { id: { in: assetIds }, userId, status: 'ready' },
        })
      : [];
    if (assets.length !== assetIds.length) {
      throw new BadRequestException('One or more media assets are not ready');
    }
    const types = new Set(assets.map((a) => a.type));
    if (types.has('image') && types.has('video')) {
      throw new BadRequestException('A post cannot mix images and video');
    }
    if (assets.filter((a) => a.type === 'video').length > 1) {
      throw new BadRequestException('Only one video per post');
    }
    if (assets.filter((a) => a.type === 'image').length > 10) {
      throw new BadRequestException('At most 10 images per post');
    }

    if (dto.taggedVenueId) {
      const venue = await this.prisma.venue.findFirst({
        where: { id: dto.taggedVenueId, status: 'active' },
        select: { id: true },
      });
      if (!venue) throw new BadRequestException('Unknown venue');
    }
    if (dto.linkedMatchId) {
      const match = await this.prisma.matchPost.findUnique({
        where: { id: dto.linkedMatchId },
        select: {
          id: true,
          authorId: true,
          joinRequests: {
            where: { userId, status: 'approved' },
            select: { id: true },
            take: 1,
          },
        },
      });
      if (!match) throw new BadRequestException('Unknown match');
      if (match.authorId !== userId && !match.joinRequests.length) {
        throw new BadRequestException('You can only link a match you play in');
      }
    }

    const authorKind: PostAuthorKind =
      isAdmin && dto.authorKind && dto.authorKind !== 'user' ? dto.authorKind : 'user';

    const hashtags = extractHashtags(text);
    const mentionTokens = extractMentionTokens(text);
    const mentionedUsers = mentionTokens.length
      ? await this.prisma.user.findMany({
          where: {
            OR: [
              { username: { in: mentionTokens, mode: 'insensitive' } },
              { name: { in: mentionTokens, mode: 'insensitive' } },
            ],
          },
          select: { id: true, username: true, name: true },
        })
      : [];
    const mentions = [...new Set(mentionedUsers.map((u) => u.id).filter((id) => id !== userId))];

    let slugSource = text;
    if (!slugSource && dto.taggedVenueId) {
      const venue = await this.prisma.venue.findUnique({
        where: { id: dto.taggedVenueId },
        select: { nameEn: true, nameAr: true, slug: true },
      });
      slugSource = venue?.nameEn || venue?.nameAr || venue?.slug || 'post';
    }
    const slug = slugifyPost(slugSource);
    const flagged = containsBlockedLanguage(text);

    const post = await this.prisma.$transaction(async (tx) => {
      const created = await tx.post.create({
        data: {
          slug,
          authorId: userId,
          authorKind,
          text,
          hashtags,
          mentions,
          taggedVenueId: dto.taggedVenueId,
          linkedMatchId: dto.linkedMatchId,
          flagged,
          media: {
            create: assets.map((asset, index) => ({
              assetId: asset.id,
              type: asset.type,
              url: asset.url,
              thumbnailUrl: asset.thumbnailUrl || asset.url,
              width: asset.width,
              height: asset.height,
              durationSeconds: asset.durationSeconds ?? undefined,
              order: index,
              altText: asset.altText ?? undefined,
            })),
          },
        },
        include: this.include(),
      });
      await this.hashtags.bumpTags(tx, hashtags, 1);
      return created;
    });

    for (const mentionId of mentions) {
      await this.notifications.create({
        userId: mentionId,
        category: 'posts',
        titleEn: 'You were mentioned in a post',
        titleAr: 'اتعمل منشن ليك في بوست',
        bodyEn: text.slice(0, 120),
        bodyAr: text.slice(0, 120),
        deepLink: `/app/community/post/${post.slug}-${post.id}`,
        payload: { postId: post.id },
      });
    }

    this.analytics.emit('post_created', userId, { postId: post.id, media: assets.length });
    return this.toDto(post);
  }

  async getByParam(param: string, viewer?: PostViewer) {
    const { id } = parsePermalinkParam(param);
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!post) throw new NotFoundException('Post not found');
    const privileged =
      viewer?.id === post.authorId || (viewer?.roles ?? []).includes('admin');
    if ((post.status === 'removed' || post.autoHidden) && !privileged) {
      throw new GoneException({
        code: 'post_removed',
        message: 'This post is no longer available',
        id: post.id,
        slug: post.slug,
      });
    }
    return this.toDto(post, viewer?.id);
  }

  async getForSeo(param: string) {
    const { id } = parsePermalinkParam(param);
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!post) throw new NotFoundException('Post not found');
    return this.toDto(post);
  }

  async feed(tab: 'following' | 'discover' | undefined, cursor: string | undefined, limit: number, viewer?: PostViewer) {
    const take = Math.min(Math.max(limit || 20, 1), 50);
    const where: Prisma.PostWhereInput = {
      status: 'active',
      autoHidden: false,
    };
    if (tab === 'following' && viewer?.id) {
      const follows = await this.prisma.follow.findMany({
        where: { followerId: viewer.id },
        select: { followingId: true },
      });
      where.authorId = { in: follows.map((f) => f.followingId) };
    }

    const rows = await this.prisma.post.findMany({
      where,
      include: this.include(),
      orderBy: { createdAt: 'desc' },
      take: take + 8,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const followed = viewer?.id
      ? new Set(
          (
            await this.prisma.follow.findMany({
              where: { followerId: viewer.id },
              select: { followingId: true },
            })
          ).map((f) => f.followingId),
        )
      : new Set<string>();

    const scored = rows
      .map((row) => ({
        row,
        score: this.score(row, followed.has(row.authorId)),
      }))
      .sort((a, b) => b.score - a.score || b.row.createdAt.getTime() - a.row.createdAt.getTime());

    const page = scored.slice(0, take).map((s) => s.row);
    const dtos = await this.toDtoList(page, viewer?.id);
    return {
      items: dtos,
      nextCursor: page.length === take ? page[page.length - 1].id : undefined,
    };
  }

  async listByAuthor(authorId: string, cursor: string | undefined, limit: number, viewer?: PostViewer) {
    return this.listWhere({ authorId, status: 'active', autoHidden: false }, cursor, limit, viewer);
  }

  async listByHashtag(tag: string, cursor: string | undefined, limit: number, viewer?: PostViewer) {
    const normalized = tag.replace(/^#/, '').toLowerCase();
    return this.listWhere(
      { status: 'active', autoHidden: false, hashtags: { has: normalized } },
      cursor,
      limit,
      viewer,
    );
  }

  async listByVenue(venueId: string, cursor: string | undefined, limit: number, viewer?: PostViewer) {
    return this.listWhere(
      { taggedVenueId: venueId, status: 'active', autoHidden: false },
      cursor,
      limit,
      viewer,
    );
  }

  async trending(limit = 12) {
    return this.hashtags.trending(limit);
  }

  async explore(viewer?: PostViewer) {
    const [hashtags, trendingPosts, suggestions] = await Promise.all([
      this.hashtags.trending(12),
      this.feed('discover', undefined, 8, viewer),
      this.suggestAccounts(viewer?.id),
    ]);
    return { hashtags, posts: trendingPosts.items, suggestions };
  }

  async updateText(userId: string, postId: string, text: string) {
    const post = await this.requireOwn(userId, postId);
    const trimmed = text.trim();
    if (!trimmed && post.media.length === 0) {
      throw new BadRequestException('Post needs text or media');
    }
    const hashtags = extractHashtags(trimmed);
    const flagged = containsBlockedLanguage(trimmed);
    const mentionTokens = extractMentionTokens(trimmed);
    const mentionedUsers = mentionTokens.length
      ? await this.prisma.user.findMany({
          where: { username: { in: mentionTokens, mode: 'insensitive' } },
          select: { id: true },
        })
      : [];
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.hashtags.bumpTags(tx, post.hashtags, -1);
      const next = await tx.post.update({
        where: { id: postId },
        data: {
          text: trimmed,
          hashtags,
          mentions: mentionedUsers.map((u) => u.id),
          flagged,
          slug: slugifyPost(trimmed || post.slug),
        },
        include: this.include(),
      });
      await this.hashtags.bumpTags(tx, hashtags, 1);
      return next;
    });
    return this.toDto(updated, userId);
  }

  async removeOwn(userId: string, postId: string) {
    await this.requireOwn(userId, postId);
    await this.prisma.post.update({
      where: { id: postId },
      data: { status: 'removed', removedReason: 'author_deleted' },
    });
    return { ok: true };
  }

  async like(userId: string, postId: string) {
    const recent = await this.prisma.postLike.count({
      where: { userId, createdAt: { gte: new Date(Date.now() - 60_000) } },
    });
    if (recent >= LIKES_PER_MINUTE) throw new ForbiddenException('Like rate limit reached');
    await this.requireActive(postId);
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.postLike.findUnique({
        where: { postId_userId: { postId, userId } },
      });
      if (!existing) {
        await tx.postLike.create({ data: { postId, userId } });
        await tx.post.update({ where: { id: postId }, data: { likeCount: { increment: 1 } } });
      }
    });
    this.analytics.emit('post_liked', userId, { postId });
    const liked = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });
    return { liked: true, likeCount: liked.likeCount };
  }

  async unlike(userId: string, postId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.postLike.deleteMany({ where: { postId, userId } });
      const count = await tx.postLike.count({ where: { postId } });
      await tx.post.update({ where: { id: postId }, data: { likeCount: count } });
    });
    const post = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });
    return { liked: false, likeCount: post.likeCount };
  }

  async save(userId: string, postId: string) {
    await this.requireActive(postId);
    await this.prisma.$transaction(async (tx) => {
      await tx.postSave.upsert({
        where: { postId_userId: { postId, userId } },
        update: {},
        create: { postId, userId },
      });
      const count = await tx.postSave.count({ where: { postId } });
      await tx.post.update({ where: { id: postId }, data: { saveCount: count } });
    });
    const post = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });
    return { saved: true, saveCount: post.saveCount };
  }

  async unsave(userId: string, postId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.postSave.deleteMany({ where: { postId, userId } });
      const count = await tx.postSave.count({ where: { postId } });
      await tx.post.update({ where: { id: postId }, data: { saveCount: count } });
    });
    const post = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });
    return { saved: false, saveCount: post.saveCount };
  }

  async share(userId: string, postId: string) {
    await this.requireActive(postId);
    try {
      const post = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.postShare.findFirst({ where: { postId, userId } });
        if (existing) {
          return tx.post.findUniqueOrThrow({ where: { id: postId } });
        }
        await tx.postShare.create({ data: { postId, userId } });
        return tx.post.update({
          where: { id: postId },
          data: { shareCount: { increment: 1 } },
        });
      });
      return { shareCount: post.shareCount };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const post = await this.prisma.post.findUniqueOrThrow({ where: { id: postId } });
        return { shareCount: post.shareCount };
      }
      throw err;
    }
  }

  async comments(postId: string, cursor?: string, limit = 30) {
    await this.requireActive(postId);
    const take = Math.min(Math.max(limit, 1), 50);
    const rows = await this.prisma.postComment.findMany({
      where: { postId, status: 'active', parentCommentId: null },
      include: {
        author: { select: AUTHOR_SELECT },
        replies: {
          where: { status: 'active' },
          include: { author: { select: AUTHOR_SELECT } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, take);
    return {
      items: page.map((c) => this.commentDto(c)),
      nextCursor: rows.length > take ? page[page.length - 1].id : undefined,
    };
  }

  async addComment(userId: string, postId: string, dto: CreateCommentDto) {
    await this.assertCanPost(userId);
    const post = await this.requireActive(postId);
    const text = dto.text.trim();
    if (!text) throw new BadRequestException('Comment cannot be empty');
    if (dto.parentCommentId) {
      const parent = await this.prisma.postComment.findUnique({
        where: { id: dto.parentCommentId },
      });
      if (!parent || parent.postId !== postId) {
        throw new BadRequestException('Invalid parent comment');
      }
      if (parent.parentCommentId) {
        throw new BadRequestException('Replies cannot be nested further');
      }
    }
    const mentionTokens = extractMentionTokens(text);
    const mentionedUsers = mentionTokens.length
      ? await this.prisma.user.findMany({
          where: { username: { in: mentionTokens, mode: 'insensitive' } },
          select: { id: true },
        })
      : [];
    const comment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.postComment.create({
        data: {
          postId,
          authorId: userId,
          parentCommentId: dto.parentCommentId,
          text,
          mentions: mentionedUsers.map((u) => u.id),
        },
        include: {
          author: { select: AUTHOR_SELECT },
          replies: { include: { author: { select: AUTHOR_SELECT } } },
        },
      });
      await tx.post.update({
        where: { id: postId },
        data: { commentCount: { increment: 1 } },
      });
      return created;
    });

    if (post.authorId !== userId) {
      await this.notifications.create({
        userId: post.authorId,
        category: 'posts',
        titleEn: 'New comment on your post',
        titleAr: 'تعليق جديد على البوست بتاعك',
        bodyEn: text.slice(0, 120),
        bodyAr: text.slice(0, 120),
        deepLink: `/app/community/post/${post.slug}-${post.id}`,
        payload: { postId, commentId: comment.id },
      });
    }
    if (dto.parentCommentId) {
      const parent = await this.prisma.postComment.findUnique({
        where: { id: dto.parentCommentId },
      });
      if (parent && parent.authorId !== userId) {
        await this.notifications.create({
          userId: parent.authorId,
          category: 'posts',
          titleEn: 'Someone replied to your comment',
          titleAr: 'حد رد على تعليقك',
          bodyEn: text.slice(0, 120),
          bodyAr: text.slice(0, 120),
          deepLink: `/app/community/post/${post.slug}-${post.id}`,
          payload: { postId, commentId: comment.id },
        });
      }
    }
    for (const mentionId of mentionedUsers.map((u) => u.id)) {
      if (mentionId === userId) continue;
      await this.notifications.create({
        userId: mentionId,
        category: 'posts',
        titleEn: 'You were mentioned in a comment',
        titleAr: 'اتعمل منشن ليك في تعليق',
        deepLink: `/app/community/post/${post.slug}-${post.id}`,
        payload: { postId, commentId: comment.id },
      });
    }
    return this.commentDto(comment);
  }

  async deleteComment(userId: string, commentId: string) {
    const comment = await this.prisma.postComment.findUnique({ where: { id: commentId } });
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.authorId !== userId) throw new ForbiddenException('Not your comment');
    await this.prisma.$transaction(async (tx) => {
      await tx.postComment.update({
        where: { id: commentId },
        data: { status: 'removed', removedReason: 'author_deleted' },
      });
      await tx.post.update({
        where: { id: comment.postId },
        data: { commentCount: { decrement: 1 } },
      });
    });
    return { ok: true };
  }

  async report(userId: string, postId: string, dto: CreatePostReportDto) {
    await this.requireActive(postId, true);
    const recent = await this.prisma.postReport.count({
      where: { reportedByUserId: userId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
    });
    if (recent >= REPORTS_PER_DAY) throw new ForbiddenException('Report rate limit reached');
    await this.prisma.postReport.upsert({
      where: { postId_reportedByUserId: { postId, reportedByUserId: userId } },
      update: { reason: dto.reason as PostReportReason, note: dto.note },
      create: {
        postId,
        reportedByUserId: userId,
        reason: dto.reason as PostReportReason,
        note: dto.note,
      },
    });
    const settings = await this.prisma.platformSetting.findUnique({ where: { id: 1 } });
    const threshold = settings?.autoHideReportThreshold ?? 5;
    const distinct = await this.prisma.postReport.groupBy({
      by: ['reportedByUserId'],
      where: { postId, status: 'open' },
    });
    if (distinct.length >= threshold) {
      await this.prisma.post.update({
        where: { id: postId },
        data: { autoHidden: true },
      });
    }
    this.analytics.emit('post_reported', userId, { postId, reason: dto.reason });
    return { ok: true };
  }

  async searchMentions(query: string) {
    const q = query.trim().replace(/^@/, '');
    if (q.length < 1) return [];
    const users = await this.prisma.user.findMany({
      where: {
        status: 'active',
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: AUTHOR_SELECT,
      take: 8,
    });
    return users;
  }

  private async listWhere(
    where: Prisma.PostWhereInput,
    cursor: string | undefined,
    limit: number,
    viewer?: PostViewer,
  ) {
    const take = Math.min(Math.max(limit || 20, 1), 50);
    const rows = await this.prisma.post.findMany({
      where,
      include: this.include(),
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, take);
    return {
      items: await this.toDtoList(page, viewer?.id),
      nextCursor: rows.length > take ? page[page.length - 1].id : undefined,
    };
  }

  private async suggestAccounts(viewerId?: string) {
    const already = viewerId
      ? (
          await this.prisma.follow.findMany({
            where: { followerId: viewerId },
            select: { followingId: true },
          })
        ).map((f) => f.followingId)
      : [];
    const exclude = [...already, ...(viewerId ? [viewerId] : [])];
    const viewer = viewerId
      ? await this.prisma.user.findUnique({
          where: { id: viewerId },
          select: { districtId: true, sportSkills: { select: { sportId: true } } },
        })
      : null;
    const sportIds = viewer?.sportSkills.map((s) => s.sportId) ?? [];
    const bySport = sportIds.length
      ? await this.prisma.user.findMany({
          where: {
            id: { notIn: exclude },
            status: 'active',
            sportSkills: { some: { sportId: { in: sportIds } } },
          },
          select: { ...AUTHOR_SELECT, _count: { select: { followsReceived: true } } },
          orderBy: { followsReceived: { _count: 'desc' } },
          take: 8,
        })
      : [];
    if (bySport.length) return bySport.map((u) => ({ ...u, followerCount: u._count.followsReceived }));
    const byDistrict = await this.prisma.user.findMany({
      where: {
        id: { notIn: exclude },
        status: 'active',
        ...(viewer?.districtId ? { districtId: viewer.districtId } : {}),
      },
      select: { ...AUTHOR_SELECT, _count: { select: { followsReceived: true } } },
      orderBy: { followsReceived: { _count: 'desc' } },
      take: 8,
    });
    return byDistrict.map((u) => ({ ...u, followerCount: u._count.followsReceived }));
  }

  private score(
    post: { createdAt: Date; likeCount: number; commentCount: number; shareCount: number },
    followed: boolean,
  ) {
    const hours = Math.max((Date.now() - post.createdAt.getTime()) / 3_600_000, 0.25);
    const velocity = (post.likeCount + post.commentCount * 2 + post.shareCount) / hours;
    return velocity + (followed ? 8 : 0) + Math.max(0, 6 - hours);
  }

  private include() {
    return {
      author: { select: AUTHOR_SELECT },
      taggedVenue: { select: { id: true, slug: true, nameEn: true, nameAr: true } },
      linkedMatch: { select: { id: true, sportId: true, dateTime: true } },
      media: { orderBy: { order: 'asc' as const } },
    };
  }

  private async requireOwn(userId: string, postId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: { media: true },
    });
    if (!post || post.status === 'removed') throw new NotFoundException('Post not found');
    if (post.authorId !== userId) throw new ForbiddenException('Not your post');
    return post;
  }

  private async requireActive(postId: string, allowHidden = false) {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    if (post.status === 'removed') throw new GoneException('This post is no longer available');
    if (post.autoHidden && !allowHidden) throw new GoneException('This post is no longer available');
    return post;
  }

  private async toDtoList(rows: Awaited<ReturnType<PostsService['loadOne']>>[], viewerId?: string) {
    return Promise.all(rows.map((row) => this.toDto(row, viewerId)));
  }

  private async loadOne(id: string) {
    return this.prisma.post.findUniqueOrThrow({ where: { id }, include: this.include() });
  }

  async toDto(
    post: {
      id: string;
      slug: string;
      authorId: string;
      authorKind: PostAuthorKind;
      text: string;
      hashtags: string[];
      mentions: string[];
      taggedVenueId: string | null;
      linkedMatchId: string | null;
      visibility: string;
      status: PostStatus;
      autoHidden: boolean;
      removedReason: string | null;
      likeCount: number;
      commentCount: number;
      shareCount: number;
      saveCount: number;
      coinsAwarded: boolean;
      createdAt: Date;
      updatedAt: Date;
      author: { id: string; name: string; username: string | null; avatarUrl: string | null };
      taggedVenue: { id: string; slug: string; nameEn: string; nameAr: string } | null;
      linkedMatch: { id: string; sportId: string; dateTime: Date } | null;
      media: Array<{
        id: string;
        type: 'image' | 'video';
        url: string;
        thumbnailUrl: string;
        width: number;
        height: number;
        durationSeconds: number | null;
        order: number;
        altText: string | null;
      }>;
    },
    viewerId?: string,
  ) {
    let liked = false;
    let saved = false;
    let following = false;
    if (viewerId) {
      const [like, save, follow] = await Promise.all([
        this.prisma.postLike.findUnique({
          where: { postId_userId: { postId: post.id, userId: viewerId } },
        }),
        this.prisma.postSave.findUnique({
          where: { postId_userId: { postId: post.id, userId: viewerId } },
        }),
        this.prisma.follow.findUnique({
          where: { followerId_followingId: { followerId: viewerId, followingId: post.authorId } },
        }),
      ]);
      liked = !!like;
      saved = !!save;
      following = !!follow;
    }
    return {
      id: post.id,
      slug: post.slug,
      permalink: `${post.slug}-${post.id}`,
      authorId: post.authorId,
      authorKind: post.authorKind,
      author: post.author,
      text: post.text,
      media: post.media,
      hashtags: post.hashtags,
      mentions: post.mentions,
      taggedVenueId: post.taggedVenueId,
      taggedVenue: post.taggedVenue,
      linkedMatchId: post.linkedMatchId,
      linkedMatch: post.linkedMatch
        ? { ...post.linkedMatch, dateTime: post.linkedMatch.dateTime.toISOString() }
        : null,
      visibility: post.visibility,
      status: post.status,
      autoHidden: post.autoHidden,
      removedReason: post.removedReason,
      likeCount: post.likeCount,
      commentCount: post.commentCount,
      shareCount: post.shareCount,
      saveCount: post.saveCount,
      liked,
      saved,
      followingAuthor: following,
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
    };
  }

  private commentDto(comment: {
    id: string;
    postId: string;
    authorId: string;
    parentCommentId: string | null;
    text: string;
    mentions: string[];
    status: PostStatus;
    createdAt: Date;
    author: { id: string; name: string; username: string | null; avatarUrl: string | null };
    replies?: Array<{
      id: string;
      postId: string;
      authorId: string;
      parentCommentId: string | null;
      text: string;
      mentions: string[];
      status: PostStatus;
      createdAt: Date;
      author: { id: string; name: string; username: string | null; avatarUrl: string | null };
    }>;
  }) {
    return {
      id: comment.id,
      postId: comment.postId,
      authorId: comment.authorId,
      parentCommentId: comment.parentCommentId,
      text: comment.text,
      mentions: comment.mentions,
      status: comment.status,
      createdAt: comment.createdAt.toISOString(),
      author: comment.author,
      replies: (comment.replies ?? []).map((r) => this.commentDto({ ...r, replies: [] })),
    };
  }
}
