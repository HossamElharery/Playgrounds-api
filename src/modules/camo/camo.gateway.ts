import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { camoEnabled, camoPublicMatchEnabled } from './camo-flags';
import type { JoinResult } from './camo-host';
import { CamoService } from './camo.service';

type Body = Record<string, unknown> | null | undefined;

const str = (v: unknown, max = 64): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Socket surface of the camo game, on the same realtime socket as everything else (`camo.*` events). */
@Injectable()
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class CamoGateway implements OnGatewayInit, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;
  /** The socket that currently owns each player: the last connection wins (section 20c). */
  private readonly active = new Map<string, string>();

  constructor(
    private readonly config: ConfigService,
    private readonly camo: CamoService,
  ) {}

  afterInit(): void {
    this.camo.attachSink({
      emit: (userId, event, payload, volatile) => {
        const room = this.server?.to(`user:${userId}`);
        if (!room) return;
        if (volatile) room.volatile.emit(event, payload);
        else room.emit(event, payload);
      },
    });
  }

  onModuleDestroy(): void {
    this.camo.attachSink(null);
  }

  handleDisconnect(client: Socket): void {
    const userId = authedUserId(client);
    if (!userId) return;
    if (this.active.get(userId) === client.id) {
      this.active.delete(userId);
      this.camo.host.disconnect(userId);
    }
  }

  private async who(client: Socket): Promise<string | null> {
    const ready = (client.data as { authReady?: Promise<void> }).authReady;
    if (ready) await ready.catch(() => undefined);
    const id = authedUserId(client);
    if (!id || !camoEnabled(this.config)) return null;
    return id;
  }

  /** Inputs only count from the socket that owns the player. */
  private owns(userId: string, client: Socket): boolean {
    return this.active.get(userId) === client.id;
  }

  @SubscribeMessage('camo.hello')
  async hello(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const hello = this.camo.host.hello(data?.['protocolVersion']);
    const verdict = { serverVersion: hello.serverVersion };
    const userId = await this.who(client);
    if (!userId) return { ok: false, reason: 'disabled', ...verdict, features: this.camo.features() };
    if (!hello.ok) return { ok: false, reason: 'protocol', ...verdict, features: this.camo.features() };
    const prev = this.active.get(userId);
    if (prev && prev !== client.id) this.server.to(prev).emit('camo.superseded', {});
    this.active.set(userId, client.id);
    const resumed = this.camo.host.reconnect(userId);
    return { ok: true, resumed, ...verdict, features: this.camo.features() };
  }

  private async joinWith(client: Socket, fn: (u: NonNullable<Awaited<ReturnType<CamoService['userFor']>>>) => JoinResult): Promise<unknown> {
    const userId = await this.who(client);
    if (!userId || !this.owns(userId, client)) return { ok: false, reason: 'not_ready' };
    const drain = this.camo.drainResult();
    if (drain) return drain;
    const user = await this.camo.userFor(userId);
    if (!user) return { ok: false, reason: 'denied', detail: 'account' };
    await this.camo.prepare(userId);
    return fn(user);
  }

  @SubscribeMessage('camo.queue.join')
  async queueJoin(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    if (!camoPublicMatchEnabled(this.config)) return { ok: false, reason: 'disabled' };
    const roomId = str(data?.['roomId']) ?? 'any';
    const partyId = str(data?.['partyId']);
    return this.joinWith(client, (u) => this.camo.host.joinPublic({ ...u, partyId }, roomId));
  }

  @SubscribeMessage('camo.queue.leave')
  async queueLeave(@ConnectedSocket() client: Socket): Promise<unknown> {
    const userId = await this.who(client);
    if (userId && this.owns(userId, client)) this.camo.host.leave(userId);
    return { ok: true };
  }

  @SubscribeMessage('camo.private.create')
  async privateCreate(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const mode = data?.['mode'] === 'contagion' ? 'contagion' : 'classic';
    return this.joinWith(client, (u) =>
      this.camo.host.createPrivate(u, {
        roomId: str(data?.['roomId']) ?? undefined,
        mode,
        prepSeconds: num(data?.['prepSeconds']) ?? undefined,
        huntSeconds: num(data?.['huntSeconds']) ?? undefined,
        bots: num(data?.['bots']) ?? undefined,
      }),
    );
  }

  @SubscribeMessage('camo.private.join')
  async privateJoin(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const code = str(data?.['code'], 12);
    if (!code) return { ok: false, reason: 'unknown_code' };
    return this.joinWith(client, (u) => this.camo.host.joinPrivate(u, code));
  }

  @SubscribeMessage('camo.private.start')
  async privateStart(@ConnectedSocket() client: Socket): Promise<unknown> {
    const userId = await this.who(client);
    return { ok: !!userId && this.owns(userId, client) && this.camo.host.hostStart(userId) };
  }

  @SubscribeMessage('camo.host.lock')
  async hostLock(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const userId = await this.who(client);
    return { ok: !!userId && this.owns(userId, client) && this.camo.host.hostLock(userId, data?.['locked'] === true) };
  }

  @SubscribeMessage('camo.host.rotateCode')
  async hostRotate(@ConnectedSocket() client: Socket): Promise<unknown> {
    const userId = await this.who(client);
    const code = userId && this.owns(userId, client) ? this.camo.host.hostRotateCode(userId) : null;
    return { ok: !!code, code };
  }

  @SubscribeMessage('camo.leave')
  async leave(@ConnectedSocket() client: Socket): Promise<unknown> {
    const userId = await this.who(client);
    if (userId && this.owns(userId, client)) this.camo.host.leave(userId);
    return { ok: true };
  }

  @SubscribeMessage('camo.resync')
  async resync(@ConnectedSocket() client: Socket): Promise<unknown> {
    const userId = await this.who(client);
    return { ok: !!userId && this.owns(userId, client) && this.camo.host.reconnect(userId) };
  }

  // ── in-match inputs ─────────────────────────────────────────────────────

  private async input<T>(client: Socket, run: (userId: string) => T): Promise<T | null> {
    const userId = await this.who(client);
    if (!userId || !this.owns(userId, client)) return null;
    return run(userId);
  }

  @SubscribeMessage('camo.move')
  async move(@ConnectedSocket() client: Socket, @MessageBody() d: Body): Promise<void> {
    const x = num(d?.['x']);
    const z = num(d?.['z']);
    const yaw = num(d?.['yaw']);
    const seq = num(d?.['seq']);
    if (x === null || z === null || yaw === null || seq === null) return;
    const res = await this.input(client, (u) => this.camo.host.move(u, { x, z, yaw, vx: num(d?.['vx']) ?? 0, vz: num(d?.['vz']) ?? 0, seq: Math.trunc(seq) >>> 0, run: d?.['run'] === true }));
    if (res?.corrected) client.emit('camo.move.correct', { x: res.x, z: res.z, seq });
  }

  @SubscribeMessage('camo.pose')
  async pose(@ConnectedSocket() client: Socket, @MessageBody() d: Body): Promise<unknown> {
    const pose = str(d?.['poseId'], 16);
    return { ok: !!pose && !!(await this.input(client, (u) => this.camo.host.pose(u, pose))) };
  }

  @SubscribeMessage('camo.freeze')
  async freeze(@ConnectedSocket() client: Socket, @MessageBody() d: Body): Promise<unknown> {
    return { ok: !!(await this.input(client, (u) => this.camo.host.freeze(u, d?.['on'] === true))) };
  }

  @SubscribeMessage('camo.paint')
  async paint(@ConnectedSocket() client: Socket, @MessageBody() d: unknown): Promise<unknown> {
    const bytes = (d as { bytes?: unknown } | null)?.bytes ?? d;
    return (await this.input(client, (u) => this.camo.host.paint(u, bytes))) ?? { accepted: 0, rejected: 0 };
  }

  @SubscribeMessage('camo.paint.reset')
  async paintReset(@ConnectedSocket() client: Socket, @MessageBody() d: unknown): Promise<unknown> {
    const bytes = (d as { bytes?: unknown } | null)?.bytes ?? d;
    return (await this.input(client, (u) => this.camo.host.paintReset(u, bytes))) ?? { accepted: 0, rejected: 0 };
  }

  @SubscribeMessage('camo.touchup')
  async touchup(@ConnectedSocket() client: Socket): Promise<unknown> {
    return { ok: !!(await this.input(client, (u) => this.camo.host.touchUp(u))) };
  }

  @SubscribeMessage('camo.kick')
  async kick(@ConnectedSocket() client: Socket, @MessageBody() d: Body): Promise<unknown> {
    const o = d?.['origin'] as Body;
    const dir = d?.['dir'];
    const ox = num(o?.['x']);
    const oy = num(o?.['y']);
    const oz = num(o?.['z']);
    if (ox === null || oy === null || oz === null || !Array.isArray(dir) || dir.length !== 3 || !dir.every((n) => typeof n === 'number')) return { ok: false };
    const r = await this.input(client, (u) =>
      this.camo.host.kick(u, { origin: { x: ox, y: oy, z: oz }, dir: dir as [number, number, number], power: num(d?.['power']) ?? 1, lob: d?.['lob'] === true, seq: Math.trunc(num(d?.['seq']) ?? 0) >>> 0 }),
    );
    return { ok: !!r };
  }

  @SubscribeMessage('camo.tag')
  async tag(@ConnectedSocket() client: Socket): Promise<unknown> {
    return { ok: !!(await this.input(client, (u) => this.camo.host.tag(u))) };
  }

  @SubscribeMessage('camo.whistle')
  async whistle(@ConnectedSocket() client: Socket): Promise<unknown> {
    return { ok: !!(await this.input(client, (u) => this.camo.host.whistle(u))) };
  }

  @SubscribeMessage('camo.scan')
  async scan(@ConnectedSocket() client: Socket): Promise<unknown> {
    return { ok: !!(await this.input(client, (u) => this.camo.host.scan(u, Date.now(), this.camo.settings().scanEnabled))) };
  }

  @SubscribeMessage('camo.taunt')
  async taunt(@ConnectedSocket() client: Socket): Promise<unknown> {
    return { ok: !!(await this.input(client, (u) => this.camo.host.taunt(u))) };
  }

  @SubscribeMessage('camo.var.skip')
  async varSkip(@ConnectedSocket() client: Socket): Promise<void> {
    await this.input(client, (u) => this.camo.host.varSkip(u));
  }

  @SubscribeMessage('camo.rematch')
  async rematch(@ConnectedSocket() client: Socket): Promise<unknown> {
    return { ok: !!(await this.input(client, (u) => this.camo.host.rematch(u))) };
  }
}

function authedUserId(client: Socket): string | null {
  const id = (client.data as { userId?: unknown } | undefined)?.userId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
