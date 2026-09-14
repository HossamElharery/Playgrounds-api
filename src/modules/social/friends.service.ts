import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { NotificationsService } from '../notifications/notifications.service';
import { withRelationshipLock } from '../../common/utils/relationship-lock.util';

@Injectable()
export class FriendsService {
  private readonly logger = new Logger(FriendsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly notifications: NotificationsService,
  ) {}

  async sendRequest(requesterId: string, addresseeId: string) {
    if (requesterId === addresseeId)
      throw new BadRequestException('Cannot friend yourself');

    const request = await withRelationshipLock(
      this.prisma,
      requesterId,
      addresseeId,
      async (tx) => {
        const recipient = await tx.user.findUnique({
          where: { id: addresseeId },
          select: { status: true },
        });
        if (!recipient || recipient.status !== 'active')
          throw new NotFoundException('Player not found');
        const blocked = await tx.userBlock.findFirst({
          where: {
            OR: [
              { blockerId: requesterId, blockedId: addresseeId },
              { blockerId: addresseeId, blockedId: requesterId },
            ],
          },
        });
        if (blocked)
          throw new ForbiddenException('Cannot send a request to this user');

        const existing = await tx.friendship.findFirst({
          where: {
            OR: [
              { requesterId, addresseeId },
              { requesterId: addresseeId, addresseeId: requesterId },
            ],
          },
        });
        if (existing) {
          if (existing.status === 'accepted')
            throw new BadRequestException('Already friends');
          if (existing.status === 'pending')
            throw new BadRequestException('Request already pending');
        }

        // A new attempt gets a new ID: old notifications cannot accept a newer request.
        if (existing)
          await tx.friendship.delete({ where: { id: existing.id } });
        return tx.friendship.create({
          data: { requesterId, addresseeId, status: 'pending' },
          include: {
            requester: { select: { id: true, name: true, avatarUrl: true } },
            addressee: { select: { id: true, name: true, avatarUrl: true } },
          },
        });
      },
    );
    this.emitter.emitToUser(addresseeId, {
      type: 'friend.request.created',
      request,
    });
    this.emitter.emitToUser(requesterId, {
      type: 'friend.request.created',
      request,
    });
    await this.notifications
      .create({
        userId: addresseeId,
        category: 'friends',
        titleEn: `${request.requester.name} sent you a friend request`,
        titleAr: `${request.requester.name} أرسل لك طلب صداقة`,
        deepLink: `/app/profile/${requesterId}`,
        payload: { requestId: request.id, requesterId, kind: 'friend.request' },
      })
      .catch(() =>
        this.logger.error('Could not deliver friend-request notification'),
      );
    return request;
  }

  async listRequests(
    userId: string,
    direction: 'incoming' | 'outgoing' | 'all' = 'incoming',
  ) {
    return this.prisma.friendship.findMany({
      where:
        direction === 'outgoing'
          ? { requesterId: userId, status: 'pending' }
          : direction === 'all'
            ? {
                status: 'pending',
                OR: [{ requesterId: userId }, { addresseeId: userId }],
              }
            : { addresseeId: userId, status: 'pending' },
      include: {
        requester: { select: { id: true, name: true, avatarUrl: true } },
        addressee: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async respond(userId: string, requestId: string, accept: boolean) {
    const request = await this.prisma.friendship.findUnique({
      where: { id: requestId },
      include: {
        addressee: { select: { name: true } },
      },
    });
    if (!request) throw new NotFoundException('Request not found');
    if (request.addresseeId !== userId)
      throw new ForbiddenException('Not your request');
    if (request.status !== 'pending')
      throw new BadRequestException('Request already resolved');

    const updated = await withRelationshipLock(
      this.prisma,
      request.requesterId,
      userId,
      async (tx) => {
        const blocked = await tx.userBlock.findFirst({
          where: {
            OR: [
              { blockerId: userId, blockedId: request.requesterId },
              { blockerId: request.requesterId, blockedId: userId },
            ],
          },
        });
        if (blocked)
          throw new ForbiddenException('Cannot respond to this request');
        const changed = await tx.friendship.updateMany({
          where: { id: requestId, status: 'pending', addresseeId: userId },
          data: {
            status: accept ? 'accepted' : 'declined',
            respondedAt: new Date(),
          },
        });
        if (changed.count !== 1)
          throw new BadRequestException('Request already resolved');
        return tx.friendship.findUniqueOrThrow({ where: { id: requestId } });
      },
    );
    this.emitter.emitToUser(request.requesterId, {
      type: 'friend.request.resolved',
      requestId,
      status: updated.status,
    });
    this.emitter.emitToUser(request.addresseeId, {
      type: 'friend.request.resolved',
      requestId,
      status: updated.status,
    });
    if (accept) {
      await this.notifications
        .create({
          userId: request.requesterId,
          category: 'friends',
          titleEn: `${request.addressee.name} accepted your friend request`,
          titleAr: `${request.addressee.name} قبل طلب صداقتك`,
          deepLink: `/app/profile/${request.addresseeId}`,
          payload: {
            requestId,
            requesterId: request.addresseeId,
            kind: 'friend.accepted',
          },
        })
        .catch(() =>
          this.logger.error(
            'Could not deliver friendship-accepted notification',
          ),
        );
    }
    return updated;
  }

  async cancel(userId: string, requestId: string) {
    const request = await this.prisma.friendship.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException('Request not found');
    if (request.requesterId !== userId)
      throw new ForbiddenException('Not your request');
    if (request.status !== 'pending')
      throw new BadRequestException('Request already resolved');
    await withRelationshipLock(
      this.prisma,
      userId,
      request.addresseeId,
      async (tx) => {
        const deleted = await tx.friendship.deleteMany({
          where: { id: requestId, requesterId: userId, status: 'pending' },
        });
        if (deleted.count !== 1)
          throw new BadRequestException('Request already resolved');
      },
    );
    this.emitter.emitToUser(userId, {
      type: 'friend.request.resolved',
      requestId,
      status: 'cancelled',
    });
    this.emitter.emitToUser(request.addresseeId, {
      type: 'friend.request.resolved',
      requestId,
      status: 'cancelled',
    });
  }

  async listFriends(
    userId: string,
    statusFilter?: 'all' | 'online' | 'offline' | 'in_squad',
    query?: string,
  ) {
    const friendships = await this.prisma.friendship.findMany({
      where: {
        status: 'accepted',
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: {
        requester: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
            lastSeenAt: true,
            lastSeenVisible: true,
          },
        },
        addressee: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
            lastSeenAt: true,
            lastSeenVisible: true,
          },
        },
      },
      orderBy: { respondedAt: 'desc' },
    });

    let friends = friendships.map((f) =>
      f.requesterId === userId ? f.addressee : f.requester,
    );
    if (query) {
      const q = query.toLowerCase();
      friends = friends.filter((f) => f.name.toLowerCase().includes(q));
    }

    const withPresence = friends.map((f) => ({
      ...f,
      presence: this.presence.stateFor(f.id),
      lastSeenAt: f.lastSeenVisible ? f.lastSeenAt : undefined,
    }));
    if (statusFilter && statusFilter !== 'all') {
      return withPresence.filter((f) => f.presence === statusFilter);
    }
    return withPresence;
  }

  async unfriend(userId: string, otherUserId: string) {
    await withRelationshipLock(this.prisma, userId, otherUserId, (tx) =>
      tx.friendship.deleteMany({
        where: {
          status: 'accepted',
          OR: [
            { requesterId: userId, addresseeId: otherUserId },
            { requesterId: otherUserId, addresseeId: userId },
          ],
        },
      }),
    );
    const event = { type: 'friend.removed', userId, otherUserId };
    this.emitter.emitToUser(userId, event);
    this.emitter.emitToUser(otherUserId, event);
  }
}
