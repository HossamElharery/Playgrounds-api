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
import { paginateByCursor } from '../../common/pagination/cursor-pagination.dto';

const PUBLIC_SENDER = { id: true, name: true, avatarUrl: true } as const;

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly notifications: NotificationsService,
  ) {}

  private pairKey(a: string, b: string): string {
    return [a, b].sort().join(':');
  }

  private async assertNotBlocked(a: string, b: string) {
    const block = await this.prisma.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
    });
    if (block) throw new ForbiddenException('Cannot message this user');
  }

  private async canMessage(fromId: string, toId: string) {
    const to = await this.prisma.user.findUnique({
      where: { id: toId },
      select: { messagePolicy: true },
    });
    const policy = to?.messagePolicy ?? 'everyone';
    if (policy === 'nobody') throw new ForbiddenException('This user is not accepting messages');
    if (policy === 'everyone') return;
    const friends = await this.prisma.friendship.findFirst({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: fromId, addresseeId: toId },
          { requesterId: toId, addresseeId: fromId },
        ],
      },
    });
    if (policy === 'friends' && !friends) {
      throw new ForbiddenException('Only friends can message this user');
    }
    if (policy === 'teammates') {
      const teammates = await this.prisma.teamMember.findFirst({
        where: {
          userId: fromId,
          team: { members: { some: { userId: toId } } },
        },
      });
      if (!friends && !teammates) {
        throw new ForbiddenException('Only teammates or friends can message this user');
      }
    }
  }

  async findOrCreateDirectThread(
    userId: string,
    participantId: string,
  ): Promise<{ thread: unknown; created: boolean }> {
    if (userId === participantId)
      throw new BadRequestException('Cannot message yourself');
    await this.assertNotBlocked(userId, participantId);
    await this.canMessage(userId, participantId);

    const key = this.pairKey(userId, participantId);
    const existing = await this.prisma.chatThread.findUnique({
      where: { pairKey: key },
    });
    if (existing)
      return {
        thread: await this.summarize(existing.id, userId),
        created: false,
      };

    const thread = await this.prisma.chatThread.create({
      data: {
        type: 'direct',
        pairKey: key,
        participants: { create: [{ userId }, { userId: participantId }] },
      },
    });
    const summary = await this.summarize(thread.id, userId);
    this.emitter.emitToUser(participantId, {
      type: 'chat.thread.created',
      thread: await this.summarize(thread.id, participantId),
    });
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
    if (!allowed) throw new ForbiddenException('Not a participant of this match');

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
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) throw new ForbiddenException('Not a member of this team');
    const team = await this.prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      include: { members: true },
    });
    if (team.chatThreadId) {
      await this.prisma.chatThreadParticipant.upsert({
        where: { threadId_userId: { threadId: team.chatThreadId, userId } },
        update: {},
        create: { threadId: team.chatThreadId, userId },
      });
      return this.summarize(team.chatThreadId, userId);
    }
    const thread = await this.prisma.chatThread.create({
      data: {
        type: 'team',
        title: title ?? team.name,
        participants: {
          create: team.members.map((m) => ({ userId: m.userId })),
        },
      },
    });
    await this.prisma.team.update({
      where: { id: teamId },
      data: { chatThreadId: thread.id },
    });
    return this.summarize(thread.id, userId);
  }

  async listMyThreads(userId: string) {
    const participations = await this.prisma.chatThreadParticipant.findMany({
      where: { userId },
      include: { thread: true },
      orderBy: { thread: { updatedAt: 'desc' } },
    });
    return Promise.all(
      participations.map((p) => this.summarize(p.threadId, userId)),
    );
  }

  async getThread(userId: string, threadId: string) {
    await this.assertParticipant(threadId, userId);
    return this.summarize(threadId, userId);
  }

  private async summarize(threadId: string, viewerId: string) {
    const thread = await this.prisma.chatThread.findUniqueOrThrow({
      where: { id: threadId },
      include: {
        participants: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true, lastSeenAt: true, lastSeenVisible: true } },
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
      ? (
          await this.prisma.chatMessage.findUnique({
            where: { id: me.lastReadMessageId },
          })
        )?.createdAt ?? new Date(0)
      : new Date(0);
    const unreadCount = await this.prisma.chatMessage.count({
      where: {
        threadId,
        deletedAt: null,
        senderId: { not: viewerId },
        createdAt: { gt: lastReadAt },
      },
    });

    return {
      id: thread.id,
      type: thread.type,
      title: thread.title,
      matchPostId: thread.matchPost?.id ?? null,
      teamId: thread.team?.id ?? null,
      participant: other
        ? {
            id: other.user.id,
            name: other.user.name,
            avatarUrl: other.user.avatarUrl,
            presence: this.presence.stateFor(other.user.id),
            lastSeenAt: other.user.lastSeenVisible
              ? other.user.lastSeenAt
              : undefined,
          }
        : undefined,
      participants: thread.participants.map((p) => ({
        id: p.user.id,
        name: p.user.name,
        avatarUrl: p.user.avatarUrl,
        presence: this.presence.stateFor(p.user.id),
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
          orderBy: { id: 'desc' },
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

    const existing = await this.prisma.chatMessage.findUnique({
      where: {
        threadId_clientMessageId: {
          threadId,
          clientMessageId: dto.clientMessageId,
        },
      },
      include: { sender: { select: PUBLIC_SENDER } },
    });
    if (existing) return this.toMessageDto(existing);

    if (dto.type === 'text' && !dto.text?.trim()) {
      throw new BadRequestException('text is required');
    }

    const message = await this.prisma.chatMessage.create({
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
    const preview = dto.text?.slice(0, 80) ?? (dto.type === 'image' ? '📷 Photo' : '🎤 Voice note');
    for (const p of participants) {
      this.emitter.emitToUser(p.userId, {
        type: 'chat.message.created',
        threadId,
        message: dtoMessage,
      });
      await this.notifications.create({
        userId: p.userId,
        category: 'chat',
        titleEn: message.sender.name,
        titleAr: message.sender.name,
        bodyEn: preview,
        bodyAr: preview,
        deepLink: `/app/chat/${threadId}`,
        payload: { threadId, messageId: message.id },
      });
    }

    return dtoMessage;
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

  async editMessage(userId: string, threadId: string, messageId: string, text: string) {
    await this.assertParticipant(threadId, userId);
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
    });
    if (!message || message.threadId !== threadId)
      throw new NotFoundException('Message not found');
    if (message.senderId !== userId)
      throw new ForbiddenException('Not your message');
    if (message.deletedAt) throw new BadRequestException('Message deleted');
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
