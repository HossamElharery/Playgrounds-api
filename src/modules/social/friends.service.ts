import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class FriendsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly notifications: NotificationsService,
  ) {}

  async sendRequest(requesterId: string, addresseeId: string) {
    if (requesterId === addresseeId)
      throw new BadRequestException('Cannot friend yourself');

    const blocked = await this.prisma.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: requesterId, blockedId: addresseeId },
          { blockerId: addresseeId, blockedId: requesterId },
        ],
      },
    });
    if (blocked) throw new ForbiddenException('Cannot send a request to this user');

    const existing = await this.prisma.friendship.findFirst({
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
      if (existing.status === 'declined' || existing.status === 'blocked') {
        return this.prisma.friendship.update({
          where: { id: existing.id },
          data: {
            requesterId,
            addresseeId,
            status: 'pending',
            respondedAt: null,
          },
        });
      }
    }

    const request = await this.prisma.friendship.create({
      data: { requesterId, addresseeId },
      include: {
        requester: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    this.emitter.emitToUser(addresseeId, {
      type: 'friend.request.created',
      request,
    });
    await this.notifications.create({
      userId: addresseeId,
      category: 'friends',
      titleEn: `${request.requester.name} sent you a friend request`,
      titleAr: `${request.requester.name} أرسل لك طلب صداقة`,
      deepLink: `/app/players`,
      payload: { requestId: request.id },
    });
    return request;
  }

  async listIncoming(userId: string, direction: 'incoming' | 'outgoing' = 'incoming') {
    return this.prisma.friendship.findMany({
      where:
        direction === 'outgoing'
          ? { requesterId: userId, status: 'pending' }
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

    const updated = await this.prisma.friendship.update({
      where: { id: requestId },
      data: {
        status: accept ? 'accepted' : 'declined',
        respondedAt: new Date(),
      },
    });
    this.emitter.emitToUser(request.requesterId, {
      type: 'friend.request.resolved',
      requestId,
      status: updated.status,
    });
    if (accept) {
      await this.notifications.create({
        userId: request.requesterId,
        category: 'friends',
        titleEn: `${request.addressee.name} accepted your friend request`,
        titleAr: `${request.addressee.name} قبل طلب صداقتك`,
        deepLink: `/app/players`,
        payload: { requestId },
      });
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
    await this.prisma.friendship.delete({ where: { id: requestId } });
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
          select: { id: true, name: true, avatarUrl: true, lastSeenAt: true, lastSeenVisible: true },
        },
        addressee: {
          select: { id: true, name: true, avatarUrl: true, lastSeenAt: true, lastSeenVisible: true },
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
    await this.prisma.friendship.deleteMany({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: userId, addresseeId: otherUserId },
          { requesterId: otherUserId, addresseeId: userId },
        ],
      },
    });
  }
}
