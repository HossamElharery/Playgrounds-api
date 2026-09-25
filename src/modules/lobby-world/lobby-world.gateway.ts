import { Injectable, OnModuleDestroy } from '@nestjs/common';
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
import { PrismaService } from '../prisma/prisma.service';
import { CLASSIC_MORPH_ID } from '../morphs/morph-catalog';
import { lobbyMorphsEnabled } from '../morphs/morphs-flag';
import { lobbyBallEnabled, lobbyMovementEnabled } from './lobby-world-flags';
import { parseLobbyKick, parseLobbyMove } from './lobby-move.util';
import { LobbyWorldService, type BallSink } from './lobby-world.service';

/** A socket that is not in the squad room may ask for a snapshot through the DB at most this often. */
export const SNAPSHOT_DB_CHECK_MS = 1000;
const MAX_ID = 64;

/**
 * Lobby World messages (`lobby.*`), on the same Socket.IO server as
 * RealtimeGateway, which authenticates every socket (`client.data.userId`)
 * and owns the `squad:<id>` rooms.
 *
 * Membership: `squad.lobby.join` puts a socket into `squad:<id>` only after a
 * database membership check, and leave / kick / the grace-period drop take it
 * out again (`revokeRoomAccess`). So "this socket is in the room" is exactly
 * "this user is a member", checked in memory — no database hit at 10 Hz.
 *
 * Movement never goes through RealtimeGateway's `inOrder` chain: that chain
 * serializes voice signaling, and 10 Hz movement must never delay an ICE
 * candidate. These handlers are synchronous (no database) and need no order.
 */
@Injectable()
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class LobbyWorldGateway
  implements OnGatewayInit, OnModuleDestroy, BallSink
{
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly world: LobbyWorldService,
  ) {}

  /** Ball ticks broadcast through this gateway (the service owns no socket). */
  afterInit(): void {
    this.world.attachBallSink(this);
  }

  onModuleDestroy(): void {
    this.world.attachBallSink(null);
  }

  toRoom(
    squadId: string,
    event: string,
    payload: object,
    volatile: boolean,
  ): void {
    const room = this.server?.to(`squad:${squadId}`);
    if (!room) return;
    if (volatile) room.volatile.emit(event, payload);
    else room.emit(event, payload);
  }

  @SubscribeMessage('lobby.move')
  move(@ConnectedSocket() client: Socket, @MessageBody() data: unknown): void {
    if (!lobbyMovementEnabled(this.config)) return;
    const userId = authedUserId(client);
    if (!userId) return;
    const move = parseLobbyMove(data);
    if (!move) return;
    const room = `squad:${move.squadId}`;
    if (!client.rooms.has(room)) return;
    const res = this.world.acceptMove(move, userId, client.id, Date.now());
    if (!res) return;
    // The mover never receives its own echo.
    const out = client.to(room);
    if (res.reliable) out.emit('lobby.moved', res.moved);
    else out.volatile.emit('lobby.moved', res.moved);
    if (res.correction) {
      client.emit('lobby.move.correct', {
        type: 'lobby.move.correct',
        squadId: move.squadId,
        ...res.correction,
      });
    }
  }

  /**
   * On lobby join, every (re)connect and tab re-visible. Answers the requester
   * only. The request can overtake `squad.lobby.join` (that one waits on a DB
   * lookup), so a socket not in the room yet gets one DB check instead.
   */
  @SubscribeMessage('lobby.snapshot.request')
  async snapshotRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { squadId?: unknown },
  ): Promise<void> {
    if (!lobbyMovementEnabled(this.config)) return;
    const userId = authedUserId(client);
    const squadId = data?.squadId;
    if (
      !userId ||
      typeof squadId !== 'string' ||
      !squadId ||
      squadId.length > MAX_ID
    )
      return;
    if (!client.rooms.has(`squad:${squadId}`)) {
      const meta = client.data as { lobbySnapshotCheckAt?: number };
      const now = Date.now();
      if (now - (meta.lobbySnapshotCheckAt ?? 0) < SNAPSHOT_DB_CHECK_MS) return;
      meta.lobbySnapshotCheckAt = now;
      const member = await this.prisma.squadMember
        .findUnique({
          where: { squadId_userId: { squadId, userId } },
          select: { id: true },
        })
        .catch(() => null);
      if (!member) return;
    }
    const withBall = lobbyBallEnabled(this.config);
    if (withBall) await this.loadMorph(userId);
    client.emit(
      'lobby.snapshot',
      this.world.snapshot(squadId, Date.now(), withBall),
    );
  }

  /**
   * `lobby.ball.kick` { squadId, seq, dirX, dirZ, power, px, pz }. Membership is the room;
   * reach, cooldown and the goal freeze are checked by the service against
   * its own positions. A refused kick is dropped silently: the kicker's
   * prediction is corrected by the next authoritative ball state.
   */
  @SubscribeMessage('lobby.ball.kick')
  kick(@ConnectedSocket() client: Socket, @MessageBody() data: unknown): void {
    if (!lobbyBallEnabled(this.config)) return;
    const userId = authedUserId(client);
    if (!userId) return;
    const kick = parseLobbyKick(data);
    if (!kick || !client.rooms.has(`squad:${kick.squadId}`)) return;
    this.world.kick(kick, userId, Date.now());
  }

  /**
   * The keeper's bigger save radius needs the member's equipped morph: read
   * once per user (then kept current by MorphsService.equipped$). Only with
   * Lobby Morphs on — with morphs off everybody is the classic avatar.
   */
  private async loadMorph(userId: string): Promise<void> {
    if (!lobbyMorphsEnabled(this.config) || this.world.hasMorph(userId)) return;
    const profile = await this.prisma.userMorphProfile
      .findUnique({ where: { userId }, select: { equippedMorphId: true } })
      .catch(() => null);
    this.world.setMorph(
      userId,
      profile?.equippedMorphId ?? CLASSIC_MORPH_ID,
      true,
    );
  }
}

function authedUserId(client: Socket): string | null {
  const id = (client.data as { userId?: unknown } | undefined)?.userId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
