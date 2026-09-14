import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMatchPostDto } from './dto/create-match-post.dto';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { NotificationsService } from '../notifications/notifications.service';
import { Prisma } from '@prisma/client';

const FIRST_JOINERS_COIN_BONUS = 30;
const FIRST_JOINERS_COUNT = 2;

@Injectable()
export class MatchPostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly notifications: NotificationsService,
  ) {}

  private async resolveSportId(key?: string) {
    if (!key) return undefined;
    const sport = await this.prisma.sportCategory.findFirst({
      where: { OR: [{ id: key }, { slug: key }, { id: `sport-${key}` }] },
    });
    if (!sport) throw new BadRequestException('Unknown sport');
    return sport.id;
  }

  async create(
    authorId: string,
    dto: CreateMatchPostDto,
    extraParticipantIds: string[] = [],
  ) {
    const sportId = await this.resolveSportId(dto.sportId);
    const thread = await this.prisma.chatThread.create({
      data: {
        type: 'match',
        title: 'Match chat',
        participants: {
          create: [
            authorId,
            ...extraParticipantIds.filter((id) => id !== authorId),
          ].map((userId) => ({ userId })),
        },
      },
    });
    return this.prisma.matchPost.create({
      data: {
        authorId,
        sportId: sportId!,
        venueId: dto.venueId,
        courtId: dto.courtId,
        districtId: dto.districtId,
        dateTime: new Date(dto.dateTime),
        playersNeeded: dto.playersNeeded,
        skillTier: dto.skillTier as never,
        costPerPlayerAmount: dto.costPerPlayerAmount,
        notes: dto.notes,
        chatThreadId: thread.id,
        gameId: dto.gameId,
        kind: dto.kind ?? 'match',
      },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
        sport: true,
      },
    });
  }

  async feed(filters: {
    sportId?: string;
    districtId?: string;
    status?: string;
  }) {
    const sportId = filters.sportId
      ? await this.resolveSportId(filters.sportId)
      : undefined;
    const posts = await this.prisma.matchPost.findMany({
      where: {
        status: (filters.status as never) ?? 'open',
        ...(sportId ? { sportId } : {}),
        ...(filters.districtId ? { districtId: filters.districtId } : {}),
      },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
        sport: true,
        venue: { select: { id: true, slug: true, nameEn: true, nameAr: true } },
        joinRequests: {
          where: { status: 'approved' },
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
        _count: { select: { comments: true, reactions: true } },
      },
      orderBy: { dateTime: 'asc' },
      take: 50,
    });
    return posts.map((p) => ({
      ...p,
      joined: p.joinRequests.map((j) => ({
        userId: j.user.id,
        name: j.user.name,
        avatar: j.user.avatarUrl,
        status: j.status,
      })),
      commentCount: p._count.comments,
      reactionCount: p._count.reactions,
    }));
  }

  async getById(id: string, viewerId?: string) {
    const post = await this.prisma.matchPost.findUnique({
      where: { id },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
        sport: true,
        venue: true,
        joinRequests: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
        _count: { select: { comments: true, reactions: true } },
      },
    });
    if (!post) throw new NotFoundException('Match post not found');
    const viewerRequest = viewerId
      ? post.joinRequests.find((request) => request.userId === viewerId)
      : undefined;
    const { joinRequests, ...safePost } = post;
    return {
      ...safePost,
      joined: joinRequests.filter((request) => request.status === 'approved').map((request) => ({
        userId: request.user.id,
        name: request.user.name,
        avatar: request.user.avatarUrl,
        status: request.status,
      })),
      viewerJoinStatus:
        post.authorId === viewerId ? 'organizer' : (viewerRequest?.status ?? 'none'),
    };
  }

  async myJoinStatuses(userId: string) {
    const [requests, authored] = await Promise.all([
      this.prisma.matchPostJoinRequest.findMany({
        where: { userId },
        select: { matchPostId: true, status: true },
      }),
      this.prisma.matchPost.findMany({ where: { authorId: userId }, select: { id: true } }),
    ]);
    return [
      ...requests.map((request) => ({ matchPostId: request.matchPostId, status: request.status })),
      ...authored.map((post) => ({ matchPostId: post.id, status: 'organizer' })),
    ];
  }

  async listJoinRequests(organizerId: string, matchPostId: string) {
    const post = await this.prisma.matchPost.findUnique({
      where: { id: matchPostId },
      select: { authorId: true },
    });
    if (!post) throw new NotFoundException('Match post not found');
    if (post.authorId !== organizerId)
      throw new ForbiddenException('Not your match post');
    return this.prisma.matchPostJoinRequest.findMany({
      where: { matchPostId, status: 'pending' },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async requestJoin(userId: string, matchPostId: string) {
    const post = await this.prisma.matchPost.findUnique({
      where: { id: matchPostId },
      include: { author: { select: { name: true } } },
    });
    if (!post) throw new NotFoundException('Match post not found');
    if (post.authorId === userId)
      throw new BadRequestException('You are the organizer');
    if (post.status !== 'open')
      throw new BadRequestException('This match is not accepting players');

    const request = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT 1 FROM "MatchPost" WHERE "id" = ${matchPostId} FOR UPDATE`;
      const current = await tx.matchPost.findUnique({ where: { id: matchPostId } });
      if (!current) throw new NotFoundException('Match post not found');
      if (current.authorId === userId) throw new BadRequestException('You are the organizer');
      if (current.status !== 'open') throw new BadRequestException('This match is not accepting players');
      const existing = await tx.matchPostJoinRequest.findUnique({ where: { matchPostId_userId: { matchPostId, userId } } });
      if (existing && existing.status !== 'declined')
        throw new BadRequestException(existing.status === 'approved' ? 'Already a match member' : 'Join request already pending');
      if (existing) {
        const changed = await tx.matchPostJoinRequest.updateMany({ where: { id: existing.id, status: 'declined' }, data: { status: 'pending' } });
        if (!changed.count) throw new BadRequestException('Request already changed');
        return tx.matchPostJoinRequest.findUniqueOrThrow({ where: { id: existing.id }, include: { user: { select: { id: true, name: true } } } });
      }
      return tx.matchPostJoinRequest.create({ data: { matchPostId, userId }, include: { user: { select: { id: true, name: true } } } });
    });
    this.emitter.emitToUser(post.authorId, {
      type: 'match.join_request.created',
      request,
    });
    await this.notifications.create({
      userId: post.authorId,
      category: 'matches',
      titleEn: `${request.user.name} wants to join your match`,
      titleAr: `${request.user.name} يريد الانضمام لمباراتك`,
      deepLink: `/app/matches/${matchPostId}`,
      payload: { matchPostId, requestId: request.id },
    });
    return this.getById(matchPostId, userId);
  }

  async leave(userId: string, matchPostId: string) {
    const post = await this.prisma.matchPost.findUnique({
      where: { id: matchPostId },
    });
    if (!post) throw new NotFoundException('Match post not found');
    if (post.authorId === userId)
      throw new BadRequestException('Organizer cannot leave — cancel instead');
    await this.prisma.matchPostJoinRequest.deleteMany({
      where: { matchPostId, userId },
    });
    if (post.chatThreadId) {
      await this.prisma.chatThreadParticipant.deleteMany({
        where: { threadId: post.chatThreadId, userId },
      });
    }
    if (post.status === 'full') {
      await this.prisma.matchPost.update({
        where: { id: matchPostId },
        data: { status: 'open' },
      });
    }
    return this.getById(matchPostId, userId);
  }

  async resolveJoin(organizerId: string, requestId: string, approve: boolean) {
    const original = await this.prisma.matchPostJoinRequest.findUnique({
      where: { id: requestId },
      include: { matchPost: true },
    });
    if (!original) throw new NotFoundException('Join request not found');
    const updated = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT 1 FROM "MatchPost" WHERE "id" = ${original.matchPostId} FOR UPDATE`;
      const request = await tx.matchPostJoinRequest.findUnique({ where: { id: requestId }, include: { matchPost: true } });
      if (!request) throw new NotFoundException('Join request not found');
      if (request.matchPost.authorId !== organizerId) throw new ForbiddenException('Not your match post');
      if (request.status !== 'pending') throw new BadRequestException('Already resolved');
      const changed = await tx.matchPostJoinRequest.updateMany({
        where: { id: requestId, status: 'pending' }, data: { status: approve ? 'approved' : 'declined' },
      });
      if (!changed.count) throw new BadRequestException('Already resolved');
      if (approve) {
        await this.addToMatchChat(request.matchPost.id, request.matchPost.authorId, request.userId, request.matchPost.chatThreadId, tx);
        const approvedCount = await tx.matchPostJoinRequest.count({ where: { matchPostId: request.matchPost.id, status: 'approved' } });
        if (approvedCount <= FIRST_JOINERS_COUNT) {
          await tx.user.update({
            where: { id: request.userId },
            data: { coinsBalance: { increment: FIRST_JOINERS_COIN_BONUS } },
          });
          await tx.coinLedgerEntry.create({
            data: {
              userId: request.userId,
              amount: FIRST_JOINERS_COIN_BONUS,
              reason: 'match_join_early',
            },
          });
        }
        if (approvedCount >= request.matchPost.playersNeeded)
          await tx.matchPost.update({ where: { id: request.matchPost.id }, data: { status: 'full' } });
      }
      return tx.matchPostJoinRequest.findUniqueOrThrow({ where: { id: requestId } });
    });

    this.emitter.emitToUser(original.userId, {
      type: 'match.join_request.resolved',
      requestId,
      status: updated.status,
    });
    await this.notifications.create({
      userId: original.userId,
      category: 'matches',
      titleEn: approve ? 'Join request approved' : 'Join request declined',
      titleAr: approve ? 'تم قبول طلب الانضمام' : 'تم رفض طلب الانضمام',
      deepLink: `/app/matches/${original.matchPost.id}`,
      payload: { matchPostId: original.matchPost.id, status: updated.status },
    });
    return updated;
  }

  private async addToMatchChat(
    matchPostId: string,
    authorId: string,
    joinerId: string,
    existingThreadId: string | null,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    let threadId = existingThreadId;
    if (!threadId) {
      const thread = await db.chatThread.create({
        data: {
          type: 'match',
          title: 'Match chat',
          participants: { create: [{ userId: authorId }] },
        },
      });
      threadId = thread.id;
      await db.matchPost.update({
        where: { id: matchPostId },
        data: { chatThreadId: threadId },
      });
    }
    await db.chatThreadParticipant.upsert({
      where: { threadId_userId: { threadId, userId: joinerId } },
      update: {},
      create: { threadId, userId: joinerId },
    });
  }

  async markPlayed(organizerId: string, id: string) {
    const post = await this.prisma.matchPost.findUnique({
      where: { id },
      include: { joinRequests: { where: { status: 'approved' } } },
    });
    if (!post) throw new NotFoundException('Match post not found');
    if (post.authorId !== organizerId)
      throw new ForbiddenException('Not your match post');
    const playerIds = [
      post.authorId,
      ...post.joinRequests.map((j) => j.userId),
    ];
    await this.prisma.$transaction(async tx => {
      const changed = await tx.matchPost.updateMany({
        where: { id, status: { in: ['open', 'full'] } },
        data: { status: 'played' },
      });
      if (!changed.count) {
        if (post.status === 'played') return;
        throw new BadRequestException('Match already closed');
      }
      await tx.user.updateMany({
        where: { id: { in: playerIds } },
        data: { matchesPlayed: { increment: 1 } },
      });
    });
    return this.getById(id);
  }

  async cancel(organizerId: string, id: string) {
    const post = await this.prisma.matchPost.findUnique({ where: { id } });
    if (!post) throw new NotFoundException('Match post not found');
    if (post.authorId !== organizerId)
      throw new ForbiddenException('Not your match post');
    return this.prisma.matchPost.update({
      where: { id },
      data: { status: 'cancelled' },
    });
  }

  mine(userId: string) {
    return this.prisma.matchPost.findMany({
      where: {
        OR: [
          { authorId: userId },
          { joinRequests: { some: { userId, status: 'approved' } } },
        ],
      },
      orderBy: { dateTime: 'desc' },
      take: 50,
    });
  }

  async listComments(matchPostId: string, cursor?: string, limit = 30) {
    await this.getById(matchPostId);
    const take = limit + 1;
    const items = await this.prisma.matchPostComment.findMany({
      where: { matchPostId, deletedAt: null },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return { items: page, nextCursor: hasMore ? page.at(-1)?.id : undefined };
  }

  async addComment(userId: string, matchPostId: string, text: string) {
    const post = await this.getById(matchPostId);
    const comment = await this.prisma.matchPostComment.create({
      data: { matchPostId, authorId: userId, text },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    this.emitter.emitToUser(post.authorId, {
      type: 'match.comment.created',
      matchPostId,
      comment,
    });
    if (post.authorId !== userId) {
      await this.notifications.create({
        userId: post.authorId,
        category: 'matches',
        titleEn: `${comment.author.name} commented on your match`,
        titleAr: `${comment.author.name} علّق على مباراتك`,
        bodyEn: text.slice(0, 120),
        bodyAr: text.slice(0, 120),
        deepLink: `/app/matches/${matchPostId}`,
        payload: { matchPostId, commentId: comment.id },
      });
    }
    return comment;
  }

  async deleteComment(userId: string, commentId: string) {
    const comment = await this.prisma.matchPostComment.findUnique({
      where: { id: commentId },
      include: { matchPost: true },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.authorId !== userId && comment.matchPost.authorId !== userId) {
      throw new ForbiddenException('Cannot delete this comment');
    }
    return this.prisma.matchPostComment.update({
      where: { id: commentId },
      data: { deletedAt: new Date(), text: '' },
    });
  }

  async toggleReaction(userId: string, matchPostId: string, emoji = 'like') {
    await this.getById(matchPostId);
    const existing = await this.prisma.matchPostReaction.findUnique({
      where: {
        matchPostId_userId_emoji: { matchPostId, userId, emoji },
      },
    });
    if (existing) {
      await this.prisma.matchPostReaction.delete({
        where: { id: existing.id },
      });
      return { reacted: false, emoji };
    }
    await this.prisma.matchPostReaction.create({
      data: { matchPostId, userId, emoji },
    });
    return { reacted: true, emoji };
  }

  async listReactions(matchPostId: string) {
    const rows = await this.prisma.matchPostReaction.groupBy({
      by: ['emoji'],
      where: { matchPostId },
      _count: { _all: true },
    });
    return rows.map((r) => ({ emoji: r.emoji, count: r._count._all }));
  }
}
