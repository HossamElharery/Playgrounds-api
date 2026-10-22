import { VoiceScopeRegistry } from './voice-scope.registry';
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
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
import { lobbyMovementEnabled } from '../lobby-world/lobby-world-flags';
import { slotsRoom } from './slot-change-relay.service';
import { publicVenueWhere } from '../../common/utils/venue-visibility.util';

export const SQUAD_EMOTE_COOLDOWN_MS = 3000;
export const SQUAD_WHEEL_EMOTE_COOLDOWN_MS = 1200;
export const LOBBY_EMOTE_IDS = [
  'wave',
  'clap',
  'dance',
  'laugh',
  'goal',
  'slide',
  'wait',
  'thumbs',
] as const;
export type LobbyEmoteId = (typeof LOBBY_EMOTE_IDS)[number];
const EMOTE_IDS: ReadonlySet<string> = new Set(LOBBY_EMOTE_IDS);
const EMOTE_PRUNE_EVERY_MS = 60_000;

@Injectable()
@WebSocketGateway({
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway
  extends RealtimeGatewayEmitter
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly lastEmoteAt = new Map<string, number>();
  private emotePruneTimer: NodeJS.Timeout | null = null;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    @Optional() private readonly voiceScopes?: VoiceScopeRegistry,
  ) {
    super();
  }

  handleConnection(client: Socket): Promise<void> {
    const ready = this.authenticate(client);
    (client.data as { authReady?: Promise<void> }).authReady = ready;
    return ready;
  }

  private async authenticate(client: Socket): Promise<void> {
    try {
      const raw = client.handshake.auth?.token ?? client.handshake.query?.token;
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
    if (!user?.lastSeenVisible)
      delete (event as { lastSeenAt?: string }).lastSeenAt;
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
    await this.authReady(client);
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
    await this.authReady(client);
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
    await this.authReady(client);
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

  /**
   * A player looking at a venue's slots asks to hear about changes to them. The room is
   * only joined for a venue that is publicly bookable (or by its own owner / staff), and a
   * socket may watch a handful of venues at a time.
   */
  @SubscribeMessage('venue.slots.watch')
  watchVenueSlots(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { venueId?: unknown },
  ) {
    return this.inOrder(client, async () => {
      const userId = this.authedUserId(client);
      const venueId = typeof data?.venueId === 'string' ? data.venueId : '';
      if (!userId || !/^[0-9a-f-]{36}$/i.test(venueId)) return;
      const watched = [...client.rooms].filter((r) => r.startsWith('venue-slots:'));
      if (watched.includes(slotsRoom(venueId))) return;
      if (watched.length >= 5) return;
      const venue = await this.prisma.venue.findFirst({
        where: {
          id: venueId,
          OR: [publicVenueWhere(), { ownerId: userId }],
        },
        select: { id: true },
      });
      if (venue) await client.join(slotsRoom(venueId));
    });
  }

  @SubscribeMessage('venue.slots.unwatch')
  unwatchVenueSlots(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { venueId?: unknown },
  ) {
    return this.inOrder(client, async () => {
      if (typeof data?.venueId === 'string') await client.leave(slotsRoom(data.venueId));
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

  @SubscribeMessage('squad.member.emote')
  memberEmote(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string; emoteId?: unknown },
  ) {
    if (data?.emoteId !== undefined) {
      this.wheelEmote(client, data);
      return Promise.resolve();
    }
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

  private wheelEmote(
    client: Socket,
    data: { squadId: string; emoteId?: unknown },
  ): void {
    if (!lobbyMovementEnabled(this.config)) return;
    const userId = this.authedUserId(client);
    const emoteId = data.emoteId;
    if (!userId || typeof data.squadId !== 'string' || !data.squadId) return;
    if (typeof emoteId !== 'string' || !EMOTE_IDS.has(emoteId)) return;
    if (!client.rooms?.has(`squad:${data.squadId}`)) return;
    const key = `${userId}:wheel`;
    const now = Date.now();
    const last = this.lastEmoteAt.get(key);
    if (last !== undefined && now - last < SQUAD_WHEEL_EMOTE_COOLDOWN_MS)
      return;
    this.lastEmoteAt.set(key, now);
    this.scheduleEmotePrune();
    this.emitToRoom(`squad:${data.squadId}`, {
      type: 'squad.member.emote',
      squadId: data.squadId,
      userId,
      emoteId,
      at: new Date(now).toISOString(),
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

  private inOrder(client: Socket, task: () => Promise<void>): Promise<void> {
    const data = client.data as { signalChain?: Promise<void> };
    const next = (data.signalChain ?? this.authReady(client))
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
    // a registered scope kind (`camo:<matchId>`) answers for itself; a plain id is a squad
    const scoped = this.voiceScopes?.check(squadId, userId) ?? null;
    if (scoped !== null) return scoped;
    return this.prisma.squadMember.findUnique({
      where: { squadId_userId: { squadId, userId } },
    });
  }

  /** Who a signal goes to and what name it carries: user ids in a squad, opaque ids in an anonymous room scope. */
  private signalPeer(
    scope: string,
    userId: string,
    toKey: string,
  ): { to: string; from: string } | null {
    if (!this.voiceScopes) return { to: toKey, from: userId };
    const to = this.voiceScopes.resolveTarget(scope, userId, toKey);
    const from = this.voiceScopes.senderKey(scope, userId);
    return to && from ? { to, from } : null;
  }

  @SubscribeMessage('voice.offer')
  voiceOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string; toUserId: string; sdp: unknown },
  ) {
    return this.inOrder(client, async () => {
      const userId = this.authedUserId(client);
      if (!userId || !data?.squadId || !data.toUserId) return;
      if (!(await this.assertSquadMember(userId, data.squadId))) return;
      const peer = this.signalPeer(data.squadId, userId, data.toUserId);
      if (!peer) return;
      if (!(await this.assertSquadMember(peer.to, data.squadId))) return;
      this.emitToUser(peer.to, {
        type: 'voice.offer',
        squadId: data.squadId,
        fromUserId: peer.from,
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
      const peer = this.signalPeer(data.squadId, userId, data.toUserId);
      if (!peer) return;
      this.emitToUser(peer.to, {
        type: 'voice.answer',
        squadId: data.squadId,
        fromUserId: peer.from,
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
      const peer = this.signalPeer(data.squadId, userId, data.toUserId);
      if (!peer) return;
      this.emitToUser(peer.to, {
        type: 'voice.ice',
        squadId: data.squadId,
        fromUserId: peer.from,
        candidate: data.candidate,
      });
    });
  }

  @SubscribeMessage('voice.speaking')
  async voiceSpeaking(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId: string; speaking: boolean },
  ) {
    await this.authReady(client);
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
      if (data.toUserId) {
        const peer = this.signalPeer(data.squadId, userId, data.toUserId);
        if (!peer) return;
        this.emitToUser(peer.to, {
          type: 'voice.hangup',
          squadId: data.squadId,
          fromUserId: peer.from,
        });
      } else {
        this.emitToRoom(`squad:${data.squadId}`, {
          type: 'voice.hangup',
          squadId: data.squadId,
          fromUserId: this.voiceScopes?.senderKey(data.squadId, userId) ?? userId,
        });
      }
    });
  }

  private authReady(client: Socket): Promise<void> {
    const ready = (client.data as { authReady?: Promise<void> } | undefined)
      ?.authReady;
    return ready ? ready.catch(() => undefined) : Promise.resolve();
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
