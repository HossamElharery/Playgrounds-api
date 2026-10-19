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
import { SendMessageDto } from './dto/send-message.dto';
import { MessageTrustService } from './message-trust.service';
import {
  fingerprintMessage,
  validateRequestMessage,
} from './message-request.rules';
import { Prisma } from '@prisma/client';
import { paginateByCursor } from '../../common/pagination/cursor-pagination.dto';
import {
  RESTRICTION_MESSAGE,
  REQUEST_VIOLATION_MESSAGE,
  normalizeMessagePolicy,
  type MessageAccess,
  type MessageRestriction,
} from './message-policy';

const PUBLIC_SENDER = { id: true, name: true, avatarUrl: true } as const;

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly notifications: NotificationsService,
    private readonly trust: MessageTrustService,
  ) {}

  private pairKey(a: string, b: string): string {
    return [a, b].sort().join(':');
  }

  private async isBlocked(a: string, b: string): Promise<boolean> {
    const block = await this.prisma.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
    });
    return !!block;
  }

  private async assertNotBlocked(a: string, b: string) {
    if (await this.isBlocked(a, b))
      throw new ForbiddenException({
        code: 'MESSAGES_BLOCKED',
        message: RESTRICTION_MESSAGE.MESSAGES_BLOCKED,
      });
  }

  /**
   * Single source of truth for "may `fromId` write to `toId`": honours the
   * recipient's privacy setting. Used when opening a conversation, on every
   * send (so a policy change takes effect on existing threads immediately) and
   * by the read-only access probe the UI uses to pre-render the composer.
   */
  async messageAccess(fromId: string, toId: string): Promise<MessageAccess> {
    const to = await this.prisma.user.findUnique({
      where: { id: toId },
      select: { messagePolicy: true, status: true, isGuest: true },
    });
    if (!to || to.status !== 'active' || to.isGuest)
      throw new NotFoundException('Player not found');
    const policy = normalizeMessagePolicy(to.messagePolicy);
    const result = (
      allowed: boolean,
      restriction: MessageRestriction | null,
      isFriend = false,
      isFollowing = false,
    ): MessageAccess => ({
      allowed,
      policy,
      restriction,
      isFriend,
      isFollowing,
    });

    if (await this.isBlocked(fromId, toId))
      return result(false, 'MESSAGES_BLOCKED');
    if (policy === 'everyone') return result(true, null);
    if (policy === 'nobody') return result(false, 'MESSAGES_CLOSED');

    const [friendship, follow] = await Promise.all([
      this.prisma.friendship.findFirst({
        where: {
          status: 'accepted',
          OR: [
            { requesterId: fromId, addresseeId: toId },
            { requesterId: toId, addresseeId: fromId },
          ],
        },
      }),
      policy === 'followers'
        ? this.prisma.follow.findUnique({
            where: {
              followerId_followingId: { followerId: fromId, followingId: toId },
            },
          })
        : Promise.resolve(null),
    ]);
    const isFriend = !!friendship;
    const isFollowing = !!follow;
    if (isFriend) return result(true, null, true, isFollowing);

    if (policy === 'friends') return result(false, 'MESSAGES_FRIENDS_ONLY');
    if (policy === 'followers') {
      return isFollowing
        ? result(true, null, false, true)
        : result(false, 'MESSAGES_FOLLOWERS_ONLY');
    }
    const teammates = await this.prisma.teamMember.findFirst({
      where: {
        userId: fromId,
        team: { members: { some: { userId: toId } } },
      },
    });
    return teammates
      ? result(true, null)
      : result(false, 'MESSAGES_TEAMMATES_ONLY');
  }

  private async canMessage(fromId: string, toId: string) {
    const access = await this.messageAccess(fromId, toId);
    if (!access.allowed && access.restriction)
      throw new ForbiddenException({
        code: access.restriction,
        message: RESTRICTION_MESSAGE[access.restriction],
      });
  }

  async getMessageAccess(userId: string, targetId: string) {
    if (userId === targetId)
      throw new BadRequestException('Cannot message yourself');
    const access = await this.messageAccess(userId, targetId);
    // A blocked viewer must not learn who blocked whom.
    const known = access.allowed
      ? await this.trust.isKnown(userId, targetId)
      : true;
    const quota =
      access.allowed && !known ? await this.getContactQuota(userId) : null;
    const existing = await this.prisma.chatThread.findUnique({
      where: { pairKey: this.pairKey(userId, targetId) },
      select: { id: true },
    });
    return {
      isKnown: known,
      hasThread: !!existing,
      quota,
      canMessage: access.allowed,
      policy:
        access.restriction === 'MESSAGES_BLOCKED' ? 'everyone' : access.policy,
      restriction: access.restriction,
      isFriend: access.isFriend,
      isFollowing: access.isFollowing,
    };
  }

  async findOrCreateDirectThread(
    userId: string,
    participantId: string,
  ): Promise<{ thread: unknown; created: boolean }> {
    if (userId === participantId)
      throw new BadRequestException('Cannot message yourself');
    await this.assertNotBlocked(userId, participantId);

    const key = this.pairKey(userId, participantId);
    const existing = await this.prisma.chatThread.findUnique({
      where: { pairKey: key },
    });
    // History stays readable after a privacy change; sending is re-checked.
    if (existing)
      return {
        thread: await this.summarize(existing.id, userId, true),
        created: false,
      };
    await this.canMessage(userId, participantId);

    // Strangers go through the message-request flow and a daily cap; people who
    // already share a friendship, team or match chat normally.
    const known = await this.trust.isKnown(userId, participantId);
    if (!known) {
      const quota = await this.trust.quota(userId);
      if (quota.remaining <= 0) throw this.trust.limitReached(quota);
    }
    let thread;
    try {
      thread = await this.prisma.chatThread.create({
        data: {
          type: 'direct',
          pairKey: key,
          requestState: known ? 'none' : 'pending',
          requestedById: known ? null : userId,
          participants: { create: [{ userId }, { userId: participantId }] },
        },
      });
    } catch (error) {
      // Two taps / two devices racing to open the same chat.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.chatThread.findUniqueOrThrow({
          where: { pairKey: key },
        });
        return {
          thread: await this.summarize(raced.id, userId, true),
          created: false,
        };
      }
      throw error;
    }
    const summary = await this.summarize(thread.id, userId, true);
    // A cold request stays invisible to the recipient until a message is sent.
    if (known) {
      this.emitter.emitToUser(participantId, {
        type: 'chat.thread.created',
        thread: await this.summarize(thread.id, participantId),
      });
    }
    return { thread: summary, created: true };
  }

  async findOrCreateMatchThread(
    userId: string,
    matchPostId: string,
    title?: string,
  ) {
    const post = await this.prisma.matchPost.findUnique({
      where: { id: matchPostId },
      include: { joinRequests: { where: { status: 'approved' } } },
    });
    if (!post) throw new NotFoundException('Match post not found');
    const allowed =
      post.authorId === userId ||
      post.joinRequests.some((j) => j.userId === userId);
    if (!allowed)
      throw new ForbiddenException('Not a participant of this match');

    if (post.chatThreadId) {
      await this.prisma.chatThreadParticipant.upsert({
        where: { threadId_userId: { threadId: post.chatThreadId, userId } },
        update: {},
        create: { threadId: post.chatThreadId, userId },
      });
      return this.summarize(post.chatThreadId, userId);
    }

    const participantIds = [
      post.authorId,
      ...post.joinRequests.map((j) => j.userId),
    ];
    const unique = [...new Set(participantIds)];
    const thread = await this.prisma.chatThread.create({
      data: {
        type: 'match',
        title: title ?? 'Match chat',
        participants: { create: unique.map((id) => ({ userId: id })) },
      },
    });
    await this.prisma.matchPost.update({
      where: { id: matchPostId },
      data: { chatThreadId: thread.id },
    });
    return this.summarize(thread.id, userId);
  }

  async findOrCreateTeamThread(userId: string, teamId: string, title?: string) {
    const threadId = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Team" WHERE "id" = ${teamId} FOR UPDATE`;
      const member = await tx.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
      });
      if (!member) throw new ForbiddenException('Not a member of this team');
      const team = await tx.team.findUniqueOrThrow({
        where: { id: teamId },
        include: { members: true },
      });
      if (team.archivedAt) throw new ForbiddenException('Team is archived');
      if (team.chatThreadId) {
        await tx.chatThreadParticipant.upsert({
          where: { threadId_userId: { threadId: team.chatThreadId, userId } },
          update: {},
          create: { threadId: team.chatThreadId, userId },
        });
        return team.chatThreadId;
      }
      const thread = await tx.chatThread.create({
        data: {
          type: 'team',
          title: title ?? team.name,
          participants: {
            create: team.members.map((m) => ({ userId: m.userId })),
          },
        },
      });
      await tx.team.update({
        where: { id: teamId },
        data: { chatThreadId: thread.id },
      });
      return thread.id;
    });
    return this.getThread(userId, threadId);
  }

  async listMyThreads(userId: string) {
    const participations = await this.prisma.chatThreadParticipant.findMany({
      where: { userId },
      include: { thread: true },
      orderBy: { thread: { updatedAt: 'desc' } },
    });
    const visible = participations.filter(({ thread }) => {
      if (thread.type !== 'direct' || thread.requestState === 'none')
        return true;
      if (thread.requestedById === userId) return true;
      // Recipient: hide dismissed requests and ones that have no message yet.
      return (
        thread.requestState === 'accepted' ||
        (thread.requestState === 'pending' && !!thread.requestedAt)
      );
    });
    return Promise.all(visible.map((p) => this.summarize(p.threadId, userId)));
  }

  async getThread(userId: string, threadId: string) {
    await this.assertParticipant(threadId, userId);
    return this.summarize(threadId, userId, true);
  }

  private async summarize(
    threadId: string,
    viewerId: string,
    withAccess = false,
  ) {
    const thread = await this.prisma.chatThread.findUniqueOrThrow({
      where: { id: threadId },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                avatarUrl: true,
                lastSeenAt: true,
                lastSeenVisible: true,
              },
            },
          },
        },
        messages: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { sender: { select: PUBLIC_SENDER } },
        },
        matchPost: { select: { id: true } },
        team: { select: { id: true, name: true } },
      },
    });

    const me = thread.participants.find((p) => p.userId === viewerId);
    const other = thread.participants.find((p) => p.userId !== viewerId);
    const lastReadAt = me?.lastReadMessageId
      ? ((
          await this.prisma.chatMessage.findUnique({
            where: { id: me.lastReadMessageId },
          })
        )?.createdAt ?? new Date(0))
      : new Date(0);
    const unreadCount = await this.prisma.chatMessage.count({
      where: {
        threadId,
        deletedAt: null,
        senderId: { not: viewerId },
        createdAt: { gt: lastReadAt },
      },
    });

    let canReply = true;
    let restriction: MessageRestriction | null = null;
    if (withAccess && thread.type === 'direct' && other) {
      const access = await this.messageAccess(viewerId, other.userId).catch(
        () => null,
      );
      if (access) {
        canReply = access.allowed;
        restriction = access.restriction;
        if (
          canReply &&
          thread.requestedById === viewerId &&
          (thread.requestState === 'pending' ||
            thread.requestState === 'declined')
        ) {
          const sent = await this.prisma.chatMessage.count({
            where: { threadId, senderId: viewerId, deletedAt: null },
          });
          if (
            sent >= 1 &&
            !(await this.trust.isKnown(viewerId, other.userId))
          ) {
            canReply = false;
            restriction = 'MESSAGES_REQUEST_PENDING';
          }
        }
      } else {
        canReply = false;
        restriction = 'MESSAGES_CLOSED';
      }
    }

    return {
      id: thread.id,
      type: thread.type,
      title: thread.title,
      canReply,
      restriction,
      requestState: thread.requestState,
      isOutgoingRequest:
        thread.type === 'direct' &&
        (thread.requestState === 'pending' ||
          thread.requestState === 'declined') &&
        thread.requestedById === viewerId,
      isIncomingRequest:
        thread.type === 'direct' &&
        thread.requestState === 'pending' &&
        !!thread.requestedById &&
        thread.requestedById !== viewerId,
      matchPostId: thread.matchPost?.id ?? null,
      teamId: thread.team?.id ?? null,
      participant: other
        ? {
            id: other.user.id,
            name: other.user.name,
            avatarUrl: other.user.avatarUrl,
            presence: this.presence.stateFor(
              other.user.id,
              other.user.lastSeenAt,
            ),
            lastSeenAt: other.user.lastSeenVisible
              ? other.user.lastSeenAt
              : undefined,
          }
        : undefined,
      participants: thread.participants.map((p) => ({
        id: p.user.id,
        name: p.user.name,
        avatarUrl: p.user.avatarUrl,
        presence: this.presence.stateFor(p.user.id, p.user.lastSeenAt),
      })),
      lastMessage: thread.messages[0]
        ? this.toMessageDto(thread.messages[0])
        : null,
      unreadCount,
      lastReadMessageId: me?.lastReadMessageId ?? null,
      updatedAt: thread.updatedAt,
    };
  }

  private toMessageDto(message: {
    id: string;
    clientMessageId: string | null;
    threadId: string;
    type: string;
    text: string | null;
    attachmentUrl: string | null;
    attachmentMime: string | null;
    attachmentSize: number | null;
    attachmentDurationMs: number | null;
    delivery: string;
    createdAt: Date;
    editedAt: Date | null;
    deletedAt: Date | null;
    sender?: { id: string; name: string; avatarUrl: string | null };
    senderId?: string;
  }) {
    if (message.deletedAt) {
      return {
        id: message.id,
        threadId: message.threadId,
        type: 'system',
        text: null,
        deletedAt: message.deletedAt,
        createdAt: message.createdAt,
      };
    }
    return {
      id: message.id,
      clientMessageId: message.clientMessageId,
      threadId: message.threadId,
      sender: message.sender ?? { id: message.senderId },
      type: message.type,
      text: message.text,
      attachment: message.attachmentUrl
        ? {
            url: message.attachmentUrl,
            mimeType: message.attachmentMime,
            size: message.attachmentSize,
            durationMs: message.attachmentDurationMs,
          }
        : undefined,
      delivery: message.delivery,
      createdAt: message.createdAt,
      editedAt: message.editedAt,
    };
  }

  private async assertParticipant(threadId: string, userId: string) {
    const participant = await this.prisma.chatThreadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId } },
    });
    if (!participant)
      throw new ForbiddenException('Not a participant of this thread');
    return participant;
  }

  async listMessages(
    userId: string,
    threadId: string,
    before?: string,
    limit = 30,
  ) {
    await this.assertParticipant(threadId, userId);
    const page = await paginateByCursor(
      (args) =>
        this.prisma.chatMessage.findMany({
          where: { threadId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: { sender: { select: PUBLIC_SENDER } },
          ...args,
        }),
      limit,
      before,
    );
    return {
      ...page,
      items: page.items.map((m) => this.toMessageDto(m)),
    };
  }

  async sendMessage(userId: string, threadId: string, dto: SendMessageDto) {
    await this.assertParticipant(threadId, userId);
    const thread = await this.prisma.chatThread.findUniqueOrThrow({
      where: { id: threadId },
      include: { participants: { select: { userId: true } } },
    });
    let recipientId: string | undefined;
    if (thread.type === 'direct') {
      const recipient = thread.participants.find(
        (participant) => participant.userId !== userId,
      );
      if (!recipient) throw new NotFoundException('Player not found');
      recipientId = recipient.userId;
      await this.assertNotBlocked(userId, recipient.userId);
      await this.canMessage(userId, recipient.userId);
    }

    const existing = await this.prisma.chatMessage.findUnique({
      where: {
        threadId_clientMessageId: {
          threadId,
          clientMessageId: dto.clientMessageId,
        },
      },
      include: { sender: { select: PUBLIC_SENDER } },
    });
    if (existing) {
      if (existing.senderId !== userId)
        throw new BadRequestException('Message ID already used');
      return this.toMessageDto(existing);
    }

    if (dto.type === 'text' && !dto.text?.trim()) {
      throw new BadRequestException('text is required');
    }
    if (dto.type === 'text') {
      // A text message never carries a file.
      dto = {
        ...dto,
        text: dto.text!.trim(),
        attachmentUrl: undefined,
        attachmentMime: undefined,
        attachmentSize: undefined,
        attachmentDurationMs: undefined,
      };
    } else if (!dto.attachmentUrl) {
      throw new BadRequestException('Invalid attachment');
    }

    await this.trust.assertNotBursting(userId);
    const request =
      thread.type === 'direct' && recipientId && thread.requestState !== 'none'
        ? await this.applyRequestRules(userId, recipientId, thread, dto)
        : { claimedSlot: false, isRequest: false };

    let message;
    try {
      message = await this.prisma.chatMessage.create({
        data: {
          threadId,
          clientMessageId: dto.clientMessageId,
          senderId: userId,
          type: dto.type,
          text: dto.text,
          attachmentUrl: dto.attachmentUrl,
          attachmentMime: dto.attachmentMime,
          attachmentSize: dto.attachmentSize,
          attachmentDurationMs: dto.attachmentDurationMs,
        },
        include: {
          sender: { select: PUBLIC_SENDER },
        },
      });
    } catch (error) {
      // The message never landed, so the player keeps their daily slot.
      if (request.claimedSlot)
        await this.trust.releaseSlot(threadId).catch(() => undefined);
      throw error;
    }

    await this.prisma.chatThread.update({
      where: { id: threadId },
      data: { updatedAt: new Date() },
    });
    const dtoMessage = this.toMessageDto(message);
    this.emitter.emitToRoom(`thread:${threadId}`, {
      type: 'chat.message.created',
      threadId,
      message: dtoMessage,
    });

    const participants = await this.prisma.chatThreadParticipant.findMany({
      where: { threadId, userId: { not: userId } },
      include: { user: { select: { name: true } } },
    });
    const preview =
      dto.text?.slice(0, 80) ??
      (dto.type === 'image' ? '📷 Photo' : '🎤 Voice note');
    for (const p of participants) {
      this.emitter.emitToUser(p.userId, {
        type: 'chat.message.created',
        threadId,
        message: dtoMessage,
      });
      await this.notifications.create({
        userId: p.userId,
        category: 'chat',
        titleEn: request.isRequest
          ? 'New message request'
          : message.sender.name,
        titleAr: request.isRequest ? 'طلب رسالة جديد' : message.sender.name,
        bodyEn: request.isRequest
          ? `${message.sender.name}: ${preview}`
          : preview,
        bodyAr: request.isRequest
          ? `${message.sender.name}: ${preview}`
          : preview,
        // A stranger's first message must never buzz the recipient's phone.
        noPush: request.isRequest,
        deepLink: `/app/chat/${threadId}`,
        payload: { threadId, messageId: message.id },
      });
    }

    return dtoMessage;
  }

  /**
   * Message-request rules for a direct thread that started as a cold contact.
   * - People who became connected, or the recipient replying, accept it.
   * - Otherwise the requester gets exactly one plain-text, link-free message.
   */
  private async applyRequestRules(
    userId: string,
    recipientId: string,
    thread: { id: string; requestState: string; requestedById: string | null },
    dto: SendMessageDto,
  ): Promise<{ claimedSlot: boolean; isRequest: boolean }> {
    const accept = async () => {
      if (thread.requestState !== 'accepted')
        await this.prisma.chatThread.update({
          where: { id: thread.id },
          data: { requestState: 'accepted' },
        });
      return { claimedSlot: false, isRequest: false };
    };
    if (thread.requestState === 'accepted') return accept();
    if (thread.requestedById !== userId) return accept();
    if (await this.trust.isKnown(userId, recipientId)) return accept();

    const pendingError = () =>
      new ForbiddenException({
        code: 'MESSAGES_REQUEST_PENDING',
        message: 'You can send more once they reply',
      });
    const alreadySent = await this.prisma.chatMessage.count({
      where: { threadId: thread.id, senderId: userId, deletedAt: null },
    });
    if (alreadySent >= 1) throw pendingError();

    const violation = validateRequestMessage(dto);
    if (violation)
      throw new ForbiddenException({
        code: violation,
        message: REQUEST_VIOLATION_MESSAGE[violation],
      });
    await this.trust.assertNotMassMessaging(
      userId,
      thread.id,
      fingerprintMessage(dto.text ?? ''),
    );
    // false = a parallel request already spent this thread's slot.
    if (!(await this.trust.claimSlot(userId, thread.id))) throw pendingError();
    return { claimedSlot: true, isRequest: true };
  }

  /** The recipient accepts or dismisses a stranger's message request. */
  async respondToRequest(
    userId: string,
    threadId: string,
    action: 'accept' | 'decline',
  ) {
    await this.assertParticipant(threadId, userId);
    const thread = await this.prisma.chatThread.findUniqueOrThrow({
      where: { id: threadId },
    });
    if (
      thread.type !== 'direct' ||
      thread.requestState !== 'pending' ||
      !thread.requestedById ||
      thread.requestedById === userId
    )
      throw new BadRequestException('There is no pending request here');
    await this.prisma.chatThread.update({
      where: { id: threadId },
      data: { requestState: action === 'accept' ? 'accepted' : 'declined' },
    });
    return this.summarize(threadId, userId, true);
  }

  async getContactQuota(userId: string) {
    const q = await this.trust.quota(userId);
    return {
      tier: q.tier,
      limit: q.limit,
      used: q.used,
      remaining: q.remaining,
      resetAt: q.resetAt,
      restricted: q.restricted,
    };
  }

  /** Fail before uploading a file the request rules would reject anyway. */
  async assertCanAttach(userId: string, threadId: string) {
    await this.assertParticipant(threadId, userId);
    const thread = await this.prisma.chatThread.findUniqueOrThrow({
      where: { id: threadId },
    });
    if (
      thread.type === 'direct' &&
      (thread.requestState === 'pending' ||
        thread.requestState === 'declined') &&
      thread.requestedById === userId
    ) {
      const other = await this.prisma.chatThreadParticipant.findFirst({
        where: { threadId, userId: { not: userId } },
        select: { userId: true },
      });
      if (!other || !(await this.trust.isKnown(userId, other.userId)))
        throw new ForbiddenException({
          code: 'MESSAGE_REQUEST_TEXT_ONLY',
          message: REQUEST_VIOLATION_MESSAGE.MESSAGE_REQUEST_TEXT_ONLY,
        });
    }
  }

  async attachFile(
    userId: string,
    threadId: string,
    file: { url: string; mime: string; size: number },
    clientMessageId: string,
    type: 'image' | 'voice',
    durationMs?: number,
  ) {
    return this.sendMessage(userId, threadId, {
      clientMessageId,
      type,
      attachmentUrl: file.url,
      attachmentMime: file.mime,
      attachmentSize: file.size,
      attachmentDurationMs: durationMs,
    });
  }

  async editMessage(
    userId: string,
    threadId: string,
    messageId: string,
    text: string,
  ) {
    await this.assertParticipant(threadId, userId);
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
    });
    if (!message || message.threadId !== threadId)
      throw new NotFoundException('Message not found');
    if (message.senderId !== userId)
      throw new ForbiddenException('Not your message');
    if (message.deletedAt) throw new BadRequestException('Message deleted');
    if (message.type !== 'text')
      throw new BadRequestException('Only text messages can be edited');
    // The one message a stranger may send must not gain a link after the fact.
    const thread = await this.prisma.chatThread.findUniqueOrThrow({
      where: { id: threadId },
    });
    if (
      thread.type === 'direct' &&
      thread.requestedById === userId &&
      (thread.requestState === 'pending' || thread.requestState === 'declined')
    ) {
      const violation = validateRequestMessage({ type: 'text', text });
      if (violation)
        throw new ForbiddenException({
          code: violation,
          message: REQUEST_VIOLATION_MESSAGE[violation],
        });
    }
    const updated = await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { text, editedAt: new Date() },
      include: { sender: { select: PUBLIC_SENDER } },
    });
    const dto = this.toMessageDto(updated);
    this.emitter.emitToRoom(`thread:${threadId}`, {
      type: 'chat.message.updated',
      threadId,
      message: dto,
    });
    return dto;
  }

  async deleteMessage(userId: string, threadId: string, messageId: string) {
    await this.assertParticipant(threadId, userId);
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
    });
    if (!message || message.threadId !== threadId)
      throw new NotFoundException('Message not found');
    if (message.senderId !== userId)
      throw new ForbiddenException('Not your message');
    const updated = await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), text: null, attachmentUrl: null },
      include: { sender: { select: PUBLIC_SENDER } },
    });
    const dto = this.toMessageDto(updated);
    this.emitter.emitToRoom(`thread:${threadId}`, {
      type: 'chat.message.updated',
      threadId,
      message: dto,
    });
    return dto;
  }

  async setReadState(
    userId: string,
    threadId: string,
    lastReadMessageId: string,
  ) {
    await this.assertParticipant(threadId, userId);
    await this.prisma.chatThreadParticipant.update({
      where: { threadId_userId: { threadId, userId } },
      data: { lastReadMessageId },
    });
    await this.prisma.chatMessage.updateMany({
      where: {
        threadId,
        senderId: { not: userId },
        delivery: { not: 'read' },
      },
      data: { delivery: 'read' },
    });
    this.emitter.emitToRoom(`thread:${threadId}`, {
      type: 'chat.read-state.changed',
      threadId,
      userId,
      lastReadMessageId,
    });
  }

  async unreadCount(userId: string): Promise<number> {
    const threads = await this.listMyThreads(userId);
    return threads.reduce(
      (sum: number, t: { unreadCount: number }) => sum + t.unreadCount,
      0,
    );
  }
}
