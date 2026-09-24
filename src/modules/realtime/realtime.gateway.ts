import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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
import { lobbyMorphsEnabled } from '../morphs/morphs-flag';

/** Per-user gap between two lobby emotes (signature moves). */
export const SQUAD_EMOTE_COOLDOWN_MS = 3000;
const EMOTE_PRUNE_EVERY_MS = 60_000;

/**
 * Single Socket.IO gateway. JWT handshake; each socket joins `user:<id>`
 * and `presence`. Feature rooms (chat/squad) are joined only after a
 * server-side membership check. Voice is WebRTC signaling (SDP/ICE)
 * relayed between squad members — no media server.
 */
@Injectable()
@WebSocketGateway({
  // CORS is owned by SocketIoAdapter (CORS_ORIGINS). Do not use `origin: '*'`
  // with credentials — browsers reject that combination.
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway
  extends RealtimeGatewayEmitter
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  /** userId -> time of the last relayed emote (Lobby Morphs signature move). */
  private readonly lastEmoteAt = new Map<string, number>();
  private emotePruneTimer: NodeJS.Timeout | null = null;

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
      const raw =
        client.handshake.auth?.token ?? client.handshake.query?.token;
      const token = Array.isArray(raw) ? raw[0] : raw;
      if (!token || typeof token !== 'string') {
        client.disconnect(true);
        return;
      }
      const payload = await this.jwtService.verifyAsync<{
        id?: unknown;
        sub?: unknown;
      }>(token, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      });
      const userId = this.jwtUserId(payload);
      if (!userId) {
        client.disconnect(true);
        return;
      }
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { status: true },
      });
      if (!user || user.status !== 'active') {
        client.disconnect(true);
        return;
      }
      client.data.userId = userId;
      await client.join(`user:${userId}`);
      await client.join('presence');
      await client.join('pulse');
      this.presence.markConnected(userId, client.id);
      await this.prisma.user.update({
        where: { id: userId },
        data: { lastSeenAt: new Date() },
      });
      await this.broadcastPresence(userId);
    } catch {
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const userId = this.authedUserId(client);
    if (!userId) return;
    this.presence.markDisconnected(userId, client.id);
    if (!this.presence.isOnline(userId)) {
      try {
        await this.prisma.user.update({
          where: { id: userId },
          data: { lastSeenAt: new Date() },
        });
        await this.broadcastPresence(userId);
      } catch (err) {
        this.logger.warn(
          `presence disconnect write skipped: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  private async broadcastPresence(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lastSeenVisible: true, lastSeenAt: true },
    });
    const event = {
      type: 'presence.changed',
      userId,
      presence: this.presence.stateFor(userId, user?.lastSeenAt),
      lastSeenAt: new Date().toISOString(),
    };
    if (!user?.lastSeenVisible) delete (event as { lastSeenAt?: string }).lastSeenAt;
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
    const userId = this.authedUserId(client);
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
    const userId = this.authedUserId(client);
    if (!userId || !data?.threadId) return;
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
    const userId = this.authedUserId(client);
    if (!userId || !data?.threadId) return;
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
  joinSquad(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string },
  ) {
    return this.inOrder(client, async () => {
      const userId = this.authedUserId(client);
      if (!userId || !data?.squadId) return;
      const member = await this.prisma.squadMember.findUnique({
        where: { squadId_userId: { squadId: data.squadId, userId } },
      });
      if (member) await client.join(`squad:${data.squadId}`);
    });
  }

  @SubscribeMessage('squad.lobby.leave')
  leaveSquadRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string },
  ) {
    return this.inOrder(client, async () => {
      if (!data?.squadId) return;
      await client.leave(`squad:${data.squadId}`);
    });
  }

  /**
   * Lobby Morphs signature move, relayed to the squad. Rate limited per user
   * (all tabs share the budget) and silently ignored while the feature is off.
   */
  @SubscribeMessage('squad.member.emote')
  memberEmote(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string },
  ) {
    return this.inOrder(client, async () => {
      if (!lobbyMorphsEnabled(this.config)) return;
      const userId = this.authedUserId(client);
      if (!userId || !data?.squadId) return;
      const now = Date.now();
      const last = this.lastEmoteAt.get(userId);
      if (last !== undefined && now - last < SQUAD_EMOTE_COOLDOWN_MS) return;
      // Reserve the slot before the lookup so two tabs cannot both pass.
      this.lastEmoteAt.set(userId, now);
      if (!(await this.assertSquadMember(userId, data.squadId))) {
        if (this.lastEmoteAt.get(userId) === now) {
          if (last === undefined) this.lastEmoteAt.delete(userId);
          else this.lastEmoteAt.set(userId, last);
        }
        return;
      }
      this.scheduleEmotePrune();
      this.emitToRoom(`squad:${data.squadId}`, {
        type: 'squad.member.emote',
        squadId: data.squadId,
        userId,
        at: new Date(now).toISOString(),
      });
    });
  }

  onModuleDestroy(): void {
    if (this.emotePruneTimer) clearInterval(this.emotePruneTimer);
    this.emotePruneTimer = null;
  }

  private scheduleEmotePrune(): void {
    if (this.emotePruneTimer) return;
    this.emotePruneTimer = setInterval(() => {
      const cutoff = Date.now() - SQUAD_EMOTE_COOLDOWN_MS;
      for (const [userId, at] of this.lastEmoteAt) {
        if (at < cutoff) this.lastEmoteAt.delete(userId);
      }
      if (!this.lastEmoteAt.size) this.onModuleDestroy();
    }, EMOTE_PRUNE_EVERY_MS);
    this.emotePruneTimer.unref?.();
  }

  /**
   * Relays one socket's squad/voice messages strictly in the order they were
   * sent. Handlers are async (membership lookups), and socket.io runs them
   * concurrently — an ICE candidate (one lookup) used to overtake the offer
   * it belongs to (two lookups) and reach the peer before that peer had a
   * connection to add it to, so it was dropped. Losing the first candidates
   * is how a fresh lobby sometimes connected with no audio at all.
   */
  private inOrder(client: Socket, task: () => Promise<void>): Promise<void> {
    const data = client.data as { signalChain?: Promise<void> };
    const next = (data.signalChain ?? Promise.resolve())
      .then(task)
      .catch((err: unknown) => {
        this.logger.warn(
          `squad signal relay failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    data.signalChain = next;
    return next;
  }

  private async assertSquadMember(userId: string, squadId: string) {
    return this.prisma.squadMember.findUnique({
      where: { squadId_userId: { squadId, userId } },
    });
  }

  /** WebRTC mesh signaling — offer/answer/ICE between two squad members. */
  @SubscribeMessage('voice.offer')
  voiceOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string; toUserId: string; sdp: unknown },
  ) {
    return this.inOrder(client, async () => {
      const userId = this.authedUserId(client);
      if (!userId || !data?.squadId || !data.toUserId) return;
      if (!(await this.assertSquadMember(userId, data.squadId))) return;
      if (!(await this.assertSquadMember(data.toUserId, data.squadId))) return;
      this.emitToUser(data.toUserId, {
        type: 'voice.offer',
        squadId: data.squadId,
        fromUserId: userId,
        sdp: data.sdp,
      });
    });
  }

  @SubscribeMessage('voice.answer')
  voiceAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string; toUserId: string; sdp: unknown },
  ) {
    return this.inOrder(client, async () => {
      const userId = this.authedUserId(client);
      if (!userId || !data?.squadId || !data.toUserId) return;
      if (!(await this.assertSquadMember(userId, data.squadId))) return;
      this.emitToUser(data.toUserId, {
        type: 'voice.answer',
        squadId: data.squadId,
        fromUserId: userId,
        sdp: data.sdp,
      });
    });
  }

  @SubscribeMessage('voice.ice')
  voiceIce(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { squadId: string; toUserId: string; candidate: unknown },
  ) {
    return this.inOrder(client, async () => {
      const userId = this.authedUserId(client);
      if (!userId || !data?.squadId || !data.toUserId) return;
      if (!(await this.assertSquadMember(userId, data.squadId))) return;
      this.emitToUser(data.toUserId, {
        type: 'voice.ice',
        squadId: data.squadId,
        fromUserId: userId,
        candidate: data.candidate,
      });
    });
  }

  @SubscribeMessage('voice.speaking')
  async voiceSpeaking(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string; speaking: boolean },
  ) {
    const userId = this.authedUserId(client);
    if (!userId || !data?.squadId) return;
    if (!(await this.assertSquadMember(userId, data.squadId))) return;
    this.emitToRoom(`squad:${data.squadId}`, {
      type: 'voice.speaking',
      squadId: data.squadId,
      userId,
      speaking: !!data.speaking,
    });
  }

  @SubscribeMessage('voice.micStatus')
  voiceMicStatus(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string; blocked: boolean },
  ) {
    return this.inOrder(client, async () => {
      const userId = this.authedUserId(client);
      if (!userId || !data?.squadId) return;
      if (!(await this.assertSquadMember(userId, data.squadId))) return;
      this.emitToRoom(`squad:${data.squadId}`, {
        type: 'voice.micStatus',
        squadId: data.squadId,
        userId,
        blocked: !!data.blocked,
      });
    });
  }

  @SubscribeMessage('voice.hangup')
  voiceHangup(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string; toUserId?: string },
  ) {
    return this.inOrder(client, async () => {
      const userId = this.authedUserId(client);
      if (!userId || !data?.squadId) return;
      if (!(await this.assertSquadMember(userId, data.squadId))) return;
      const event = {
        type: 'voice.hangup',
        squadId: data.squadId,
        fromUserId: userId,
      };
      if (data.toUserId) this.emitToUser(data.toUserId, event);
      else this.emitToRoom(`squad:${data.squadId}`, event);
    });
  }

  private authedUserId(client: Socket): string | null {
    const id = client.data?.userId;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  private jwtUserId(payload: { id?: unknown; sub?: unknown }): string | null {
    if (typeof payload.id === 'string' && payload.id) return payload.id;
    if (typeof payload.sub === 'string' && payload.sub) return payload.sub;
    return null;
  }

  emitToUser(
    userId: string,
    event: { type: string; [key: string]: unknown },
  ): void {
    this.server?.to(`user:${userId}`).emit(event.type, event);
  }

  disconnectUser(userId: string): void {
    this.server?.in(`user:${userId}`).disconnectSockets(true);
  }

  revokeRoomAccess(userId: string, room: string): void {
    this.server?.in(`user:${userId}`).socketsLeave(room);
  }

  emitToRoom(
    room: string,
    event: { type: string; [key: string]: unknown },
  ): void {
    this.server?.to(room).emit(event.type, event);
  }
}
