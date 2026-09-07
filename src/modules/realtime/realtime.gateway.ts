import { Injectable, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import { RealtimeGatewayEmitter } from './realtime-emitter.interface';

/**
 * Single Socket.IO gateway. JWT handshake; each socket joins `user:<id>`
 * and `presence`. Feature rooms (chat/squad) are joined only after a
 * server-side membership check. Voice is WebRTC signaling (SDP/ICE)
 * relayed between squad members — no media server.
 */
@Injectable()
@WebSocketGateway({ cors: { origin: '*', credentials: true } })
export class RealtimeGateway
  extends RealtimeGatewayEmitter
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
  ) {
    super();
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token =
        (client.handshake.auth?.token as string) ??
        (client.handshake.query?.token as string);
      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      });
      client.data.userId = payload.id;
      await client.join(`user:${payload.id}`);
      await client.join('presence');
      this.presence.markConnected(payload.id, client.id);
      await this.prisma.user.update({
        where: { id: payload.id },
        data: { lastSeenAt: new Date() },
      });
      await this.broadcastPresence(payload.id);
    } catch {
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const userId = client.data?.userId as string | undefined;
    if (!userId) return;
    this.presence.markDisconnected(userId, client.id);
    if (!this.presence.isOnline(userId)) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { lastSeenAt: new Date() },
      });
      await this.broadcastPresence(userId);
    }
  }

  private async broadcastPresence(userId: string) {
    const event = {
      type: 'presence.changed',
      userId,
      presence: this.presence.stateFor(userId),
      lastSeenAt: new Date().toISOString(),
    };
    this.emitToRoom('presence', event);
    const friends = await this.prisma.friendship.findMany({
      where: {
        status: 'accepted',
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
    });
    for (const f of friends) {
      const other = f.requesterId === userId ? f.addresseeId : f.requesterId;
      this.emitToUser(other, event);
    }
  }

  @SubscribeMessage('presence.heartbeat')
  async heartbeat(@ConnectedSocket() client: Socket) {
    const userId = client.data.userId as string;
    if (!userId) return;
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastSeenAt: new Date() },
    });
  }

  @SubscribeMessage('chat.thread.join')
  async joinThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ) {
    const userId = client.data.userId as string;
    const participant = await this.prisma.chatThreadParticipant.findUnique({
      where: { threadId_userId: { threadId: data.threadId, userId } },
    });
    if (participant) await client.join(`thread:${data.threadId}`);
  }

  @SubscribeMessage('chat.thread.leave')
  async leaveThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ) {
    await client.leave(`thread:${data.threadId}`);
  }

  @SubscribeMessage('chat.typing')
  async typing(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string; typing: boolean },
  ) {
    const userId = client.data.userId as string;
    const participant = await this.prisma.chatThreadParticipant.findUnique({
      where: { threadId_userId: { threadId: data.threadId, userId } },
    });
    if (!participant) return;
    client.to(`thread:${data.threadId}`).emit('chat.typing.changed', {
      type: 'chat.typing.changed',
      threadId: data.threadId,
      userId,
      typing: data.typing,
    });
  }

  @SubscribeMessage('squad.lobby.join')
  async joinSquad(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string },
  ) {
    const userId = client.data.userId as string;
    const member = await this.prisma.squadMember.findUnique({
      where: { squadId_userId: { squadId: data.squadId, userId } },
    });
    if (member) await client.join(`squad:${data.squadId}`);
  }

  @SubscribeMessage('squad.lobby.leave')
  async leaveSquadRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string },
  ) {
    await client.leave(`squad:${data.squadId}`);
  }

  private async assertSquadMember(userId: string, squadId: string) {
    return this.prisma.squadMember.findUnique({
      where: { squadId_userId: { squadId, userId } },
    });
  }

  /** WebRTC mesh signaling — offer/answer/ICE between two squad members. */
  @SubscribeMessage('voice.offer')
  async voiceOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string; toUserId: string; sdp: unknown },
  ) {
    const userId = client.data.userId as string;
    if (!(await this.assertSquadMember(userId, data.squadId))) return;
    if (!(await this.assertSquadMember(data.toUserId, data.squadId))) return;
    this.emitToUser(data.toUserId, {
      type: 'voice.offer',
      squadId: data.squadId,
      fromUserId: userId,
      sdp: data.sdp,
    });
  }

  @SubscribeMessage('voice.answer')
  async voiceAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string; toUserId: string; sdp: unknown },
  ) {
    const userId = client.data.userId as string;
    if (!(await this.assertSquadMember(userId, data.squadId))) return;
    this.emitToUser(data.toUserId, {
      type: 'voice.answer',
      squadId: data.squadId,
      fromUserId: userId,
      sdp: data.sdp,
    });
  }

  @SubscribeMessage('voice.ice')
  async voiceIce(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { squadId: string; toUserId: string; candidate: unknown },
  ) {
    const userId = client.data.userId as string;
    if (!(await this.assertSquadMember(userId, data.squadId))) return;
    this.emitToUser(data.toUserId, {
      type: 'voice.ice',
      squadId: data.squadId,
      fromUserId: userId,
      candidate: data.candidate,
    });
  }

  @SubscribeMessage('voice.speaking')
  async voiceSpeaking(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string; speaking: boolean },
  ) {
    const userId = client.data.userId as string;
    if (!(await this.assertSquadMember(userId, data.squadId))) return;
    this.emitToRoom(`squad:${data.squadId}`, {
      type: 'voice.speaking',
      squadId: data.squadId,
      userId,
      speaking: !!data.speaking,
    });
  }

  @SubscribeMessage('voice.hangup')
  async voiceHangup(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string; toUserId?: string },
  ) {
    const userId = client.data.userId as string;
    if (!(await this.assertSquadMember(userId, data.squadId))) return;
    const event = {
      type: 'voice.hangup',
      squadId: data.squadId,
      fromUserId: userId,
    };
    if (data.toUserId) this.emitToUser(data.toUserId, event);
    else this.emitToRoom(`squad:${data.squadId}`, event);
  }

  emitToUser(
    userId: string,
    event: { type: string; [key: string]: unknown },
  ): void {
    this.server?.to(`user:${userId}`).emit(event.type, event);
  }

  emitToRoom(
    room: string,
    event: { type: string; [key: string]: unknown },
  ): void {
    this.server?.to(room).emit(event.type, event);
  }
}
