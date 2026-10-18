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

export const SNAPSHOT_DB_CHECK_MS = 1000;
const MAX_ID = 64;

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

  @SubscribeMessage('lobby.ball.kick')
  kick(@ConnectedSocket() client: Socket, @MessageBody() data: unknown): void {
    if (!lobbyBallEnabled(this.config)) return;
    const userId = authedUserId(client);
    if (!userId) return;
    const kick = parseLobbyKick(data);
    if (!kick || !client.rooms.has(`squad:${kick.squadId}`)) return;
    this.world.kick(kick, userId, Date.now());
  }

  @SubscribeMessage('lobby.pen.start')
  penStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): void {
    const target = this.penTarget(client, data);
    if (target)
      this.world.startPenalty(target.squadId, target.userId, Date.now());
  }

  @SubscribeMessage('lobby.pen.cancel')
  penCancel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): void {
    const target = this.penTarget(client, data);
    if (target)
      this.world.cancelPenalty(target.squadId, target.userId, Date.now());
  }

  @SubscribeMessage('lobby.pen.dive')
  penDive(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): void {
    const target = this.penTarget(client, data);
    const dir = (data as { dir?: unknown } | null)?.dir;
    if (target && (dir === -1 || dir === 0 || dir === 1))
      this.world.divePenalty(target.squadId, target.userId, dir, Date.now());
  }

  @SubscribeMessage('lobby.pen.join')
  penJoin(@ConnectedSocket() client: Socket, @MessageBody() data: unknown): void {
    const target = this.penTarget(client, data);
    if (target) this.world.joinPenalty(target.squadId, target.userId, Date.now());
  }

  @SubscribeMessage('lobby.pen.decline')
  penDecline(@ConnectedSocket() client: Socket, @MessageBody() data: unknown): void {
    const target = this.penTarget(client, data);
    if (target) this.world.declinePenalty(target.squadId, target.userId, Date.now());
  }

  private penTarget(
    client: Socket,
    data: unknown,
  ): { squadId: string; userId: string } | null {
    if (!lobbyBallEnabled(this.config)) return null;
    const userId = authedUserId(client);
    const squadId = (data as { squadId?: unknown } | null)?.squadId;
    if (
      !userId ||
      typeof squadId !== 'string' ||
      !squadId ||
      squadId.length > MAX_ID
    )
      return null;
    if (!client.rooms.has(`squad:${squadId}`)) return null;
    return { squadId, userId };
  }

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
