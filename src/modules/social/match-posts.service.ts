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

  async getById(id: string) {
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
    return post;
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

    const request = await this.prisma.matchPostJoinRequest.upsert({
      where: { matchPostId_userId: { matchPostId, userId } },
      update: { status: 'pending' },
      create: { matchPostId, userId },
      include: { user: { select: { id: true, name: true } } },
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
    return request;
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
    return this.getById(matchPostId);
  }

  async resolveJoin(organizerId: string, requestId: string, approve: boolean) {
    const request = await this.prisma.matchPostJoinRequest.findUnique({
      where: { id: requestId },
      include: { matchPost: true },
    });
    if (!request) throw new NotFoundException('Join request not found');
    if (request.matchPost.authorId !== organizerId)
      throw new ForbiddenException('Not your match post');
    if (request.status !== 'pending')
      throw new BadRequestException('Already resolved');

    const updated = await this.prisma.matchPostJoinRequest.update({
      where: { id: requestId },
      data: { status: approve ? 'approved' : 'declined' },
    });

    if (approve) {
      await this.addToMatchChat(
        request.matchPost.id,
        request.matchPost.authorId,
        request.userId,
        request.matchPost.chatThreadId,
      );
      const approvedCount = await this.prisma.matchPostJoinRequest.count({
        where: { matchPostId: request.matchPost.id, status: 'approved' },
      });
      if (approvedCount <= FIRST_JOINERS_COUNT) {
        await this.prisma.$transaction([
          this.prisma.user.update({
            where: { id: request.userId },
            data: { coinsBalance: { increment: FIRST_JOINERS_COIN_BONUS } },
          }),
          this.prisma.coinLedgerEntry.create({
            data: {
              userId: request.userId,
              amount: FIRST_JOINERS_COIN_BONUS,
              reason: 'match_join_early',
            },
          }),
        ]);
      }
      if (approvedCount >= request.matchPost.playersNeeded) {
        await this.prisma.matchPost.update({
          where: { id: request.matchPost.id },
          data: { status: 'full' },
        });
      }
    }

    this.emitter.emitToUser(request.userId, {
      type: 'match.join_request.resolved',
      requestId,
      status: updated.status,
    });
    await this.notifications.create({
      userId: request.userId,
      category: 'matches',
      titleEn: approve ? 'Join request approved' : 'Join request declined',
      titleAr: approve ? 'تم قبول طلب الانضمام' : 'تم رفض طلب الانضمام',
      deepLink: `/app/matches/${request.matchPost.id}`,
      payload: { matchPostId: request.matchPost.id, status: updated.status },
    });
    return updated;
  }

  private async addToMatchChat(
    matchPostId: string,
    authorId: string,
    joinerId: string,
    existingThreadId: string | null,
  ) {
    let threadId = existingThreadId;
    if (!threadId) {
      const thread = await this.prisma.chatThread.create({
        data: {
          type: 'match',
          title: 'Match chat',
          participants: { create: [{ userId: authorId }] },
        },
      });
      threadId = thread.id;
      await this.prisma.matchPost.update({
        where: { id: matchPostId },
        data: { chatThreadId: threadId },
      });
    }
    await this.prisma.chatThreadParticipant.upsert({
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
    await this.prisma.matchPost.update({
      where: { id },
      data: { status: 'played' },
    });
    await this.prisma.user.updateMany({
      where: { id: { in: playerIds } },
      data: { matchesPlayed: { increment: 1 } },
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
