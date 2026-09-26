import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { lobbyKioskEnabled } from './lobby-kiosk-flags';
import { LobbyKioskService } from './lobby-kiosk.service';

const MAX_ID = 64;

/**
 * `lobby.kiosk.*` on the same Socket.IO server as RealtimeGateway.
 * Voice and `inOrder` are untouched: these handlers are separate, like
 * LobbyWorldGateway. Membership is "this socket is in `squad:<id>`".
 */
@Injectable()
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class LobbyKioskGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly config: ConfigService,
    private readonly kiosk: LobbyKioskService,
  ) {}

  afterInit(): void {
    this.kiosk.broadcaster = {
      emit: (squadId, event, payload) => {
        this.server?.to(`squad:${squadId}`).emit(event, payload);
      },
    };
  }

  onModuleDestroy(): void {
    this.kiosk.broadcaster = null;
  }

  @SubscribeMessage('lobby.kiosk.state.request')
  state(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId?: unknown },
  ): void {
    const squadId = this.guard(client, data?.squadId);
    if (!squadId) return;
    client.emit('lobby.kiosk.state', this.kiosk.state(squadId));
  }

  @SubscribeMessage('lobby.kiosk.busy')
  busy(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId?: unknown; busy?: unknown },
  ): void {
    const squadId = this.guard(client, data?.squadId);
    const userId = authedUserId(client);
    if (!squadId || !userId || typeof data?.busy !== 'boolean') return;
    this.kiosk.setBusy(squadId, userId, data.busy);
  }

  @SubscribeMessage('lobby.kiosk.propose')
  async propose(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: Record<string, unknown> | null,
  ): Promise<void> {
    const squadId = this.guard(client, data?.squadId);
    const userId = authedUserId(client);
    if (!squadId || !userId || !data) return;
    await this.kiosk.propose(userId, {
      squadId,
      venueId: str(data.venueId),
      courtId: data.courtId == null ? null : str(data.courtId),
      date: str(data.date),
      startTime: str(data.startTime),
      durationMin: typeof data.durationMin === 'number' ? data.durationMin : NaN,
      priceFrom: typeof data.priceFrom === 'number' ? data.priceFrom : undefined,
      playersNeeded: typeof data.playersNeeded === 'number' ? data.playersNeeded : undefined,
    });
  }

  @SubscribeMessage('lobby.kiosk.vote')
  async vote(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId?: unknown; proposalId?: unknown; vote?: unknown },
  ): Promise<void> {
    const squadId = this.guard(client, data?.squadId);
    const userId = authedUserId(client);
    if (!squadId || !userId || !validId(data?.proposalId)) return;
    await this.kiosk.vote(userId, squadId, data.proposalId, data.vote);
  }

  @SubscribeMessage('lobby.kiosk.cancel')
  async cancel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId?: unknown; proposalId?: unknown },
  ): Promise<void> {
    const squadId = this.guard(client, data?.squadId);
    const userId = authedUserId(client);
    if (!squadId || !userId || !validId(data?.proposalId)) return;
    await this.kiosk.cancel(userId, squadId, data.proposalId);
  }

  @SubscribeMessage('lobby.kiosk.booked')
  async booked(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId?: unknown; proposalId?: unknown; bookingId?: unknown },
  ): Promise<void> {
    const squadId = this.guard(client, data?.squadId);
    const userId = authedUserId(client);
    if (!squadId || !userId || !validId(data?.proposalId) || !validId(data?.bookingId)) return;
    await this.kiosk.booked(userId, squadId, data.proposalId, data.bookingId);
  }

  @SubscribeMessage('lobby.kiosk.presence')
  presence(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId?: unknown; venueId?: unknown; center?: unknown; open?: unknown },
  ): void {
    const squadId = this.guard(client, data?.squadId);
    const userId = authedUserId(client);
    if (!squadId || !userId) return;
    if (data?.open === false) {
      this.kiosk.setPresence(squadId, userId, null);
      return;
    }
    const center = mapCenter(data?.center);
    this.kiosk.setPresence(squadId, userId, {
      venueId: typeof data?.venueId === 'string' ? data.venueId : undefined,
      center,
    });
  }

  @SubscribeMessage('lobby.kiosk.shortlist.add')
  async shortlistAdd(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId?: unknown; venueId?: unknown },
  ): Promise<void> {
    const squadId = this.guard(client, data?.squadId);
    const userId = authedUserId(client);
    if (!squadId || !userId || !validId(data?.venueId)) return;
    await this.kiosk.addShortlist(squadId, userId, data.venueId);
  }

  @SubscribeMessage('lobby.kiosk.shortlist.remove')
  async shortlistRemove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId?: unknown; venueId?: unknown },
  ): Promise<void> {
    const squadId = this.guard(client, data?.squadId);
    const userId = authedUserId(client);
    if (!squadId || !userId || !validId(data?.venueId)) return;
    await this.kiosk.removeShortlist(squadId, userId, data.venueId);
  }

  /** Flag, auth, room, then the per-user rate limit. Null means "drop it". */
  private guard(client: Socket, squadId: unknown): string | null {
    if (!lobbyKioskEnabled(this.config)) return null;
    const userId = authedUserId(client);
    if (!userId || !validId(squadId)) return null;
    if (!client.rooms.has(`squad:${squadId}`)) return null;
    if (!this.kiosk.allow(userId)) return null;
    return squadId;
  }
}

function authedUserId(client: Socket): string | null {
  const id = (client.data as { userId?: unknown } | undefined)?.userId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Map camera only. A GPS fix is not a field on this payload. */
function mapCenter(value: unknown): { lat: number; lng: number; zoom: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as { lat?: unknown; lng?: unknown; zoom?: unknown };
  if (typeof c.lat !== 'number' || typeof c.lng !== 'number' || typeof c.zoom !== 'number') return undefined;
  return { lat: c.lat, lng: c.lng, zoom: c.zoom };
}
