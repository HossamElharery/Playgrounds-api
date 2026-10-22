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
import { camoDailyEnabled, camoEnabled, camoPublicMatchEnabled } from './camo-flags';
import type { JoinResult } from './camo-host';
import { VoiceScopeRegistry } from '../realtime/voice-scope.registry';
import { LobbyWorldService } from '../lobby-world/lobby-world.service';
import { CamoService } from './camo.service';

const INVITE_MS = 15_000;

interface SquadInvite {
  id: string;
  squadId: string;
  hostId: string;
  hostName: string;
  code: string;
  expiresAt: number;
  invited: Set<string>;
}

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
    private readonly lobby: LobbyWorldService,
    private readonly voiceScopes: VoiceScopeRegistry,
  ) {}

  private readonly invites = new Map<string, SquadInvite>();
  /** Squad members currently inside a camo match, per squad (for the lobby badge). */
  private readonly squadPlaying = new Map<string, Set<string>>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  afterInit(): void {
    this.lobby.setExternalBusy((userId) => this.camo.host.isPlaying(userId));
    // voice signalling for `camo:<matchId>`: only people seated in that match, and never someone the room muted
    this.voiceScopes.register('camo', (matchId, userId) => {
      const m = this.camo.host.matchOf(userId);
      return !!m && m.id === matchId && !m.mod.muted.has(userId);
    });
    this.sweeper = setInterval(() => this.sweepSquads(), 5000);
    this.sweeper.unref?.();
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
    if (this.sweeper) clearInterval(this.sweeper);
    this.lobby.setExternalBusy(null);
    this.voiceScopes.unregister('camo');
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
    if (!id || !camoEnabled(this.camo.flags)) return null;
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
    const notices = await this.camo.moderation.notices(userId).catch(() => null);
    return { ok: true, resumed, ...verdict, features: this.camo.features(), notices };
  }

  private async joinWith(client: Socket, fn: (u: NonNullable<Awaited<ReturnType<CamoService['userFor']>>>) => JoinResult): Promise<unknown> {
    const userId = await this.who(client);
    if (!userId || !this.owns(userId, client)) return { ok: false, reason: 'not_ready' };
    const drain = this.camo.drainResult();
    if (drain) return drain;
    if (this.lobby.userInLobbyGame(userId)) return { ok: false, reason: 'in_lobby_game' };
    const user = await this.camo.userFor(userId);
    if (!user) return { ok: false, reason: 'denied', detail: 'account' };
    await this.camo.prepare(userId);
    return fn(user);
  }

  @SubscribeMessage('camo.queue.join')
  async queueJoin(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    if (!camoPublicMatchEnabled(this.camo.flags)) return { ok: false, reason: 'disabled' };
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

  // ── squad play (section 4.1b): the host starts, the squad gets a 15 s invite ──────────────

  private publishSquad(squadId: string): void {
    const live = [...(this.squadPlaying.get(squadId) ?? [])].filter((id) => this.camo.host.isPlaying(id));
    if (live.length) this.squadPlaying.set(squadId, new Set(live));
    else this.squadPlaying.delete(squadId);
    this.server?.to(`squad:${squadId}`).emit('camo.lobby.status', { squadId, playingUserIds: live });
  }

  private sweepSquads(): void {
    const now = Date.now();
    for (const [id, inv] of this.invites) if (inv.expiresAt + 60_000 < now) this.invites.delete(id);
    for (const squadId of [...this.squadPlaying.keys()]) this.publishSquad(squadId);
  }

  @SubscribeMessage('camo.squad.start')
  async squadStart(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const squadId = str(data?.['squadId']);
    if (!squadId || !client.rooms.has(`squad:${squadId}`)) return { ok: false, reason: 'denied' };
    const userId = await this.who(client);
    if (!userId) return { ok: false, reason: 'disabled' };
    const mode = data?.['mode'] === 'contagion' ? 'contagion' : 'classic';
    const made = (await this.joinWith(client, (u) => this.camo.host.createPrivate(u, { mode, bots: num(data?.['bots']) ?? 5 }))) as JoinResult;
    if (!made.ok || !made.code) return made;
    const hostUser = await this.camo.userFor(userId);
    const sockets = await this.server.in(`squad:${squadId}`).fetchSockets();
    const invited = new Set<string>();
    for (const s of sockets) {
      const id = authedUserId(s as unknown as Socket);
      if (id && id !== userId) invited.add(id);
    }
    const invite: SquadInvite = { id: `si${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, squadId, hostId: userId, hostName: hostUser?.name ?? '', code: made.code, expiresAt: Date.now() + INVITE_MS, invited };
    this.invites.set(invite.id, invite);
    for (const id of invited) this.server.to(`user:${id}`).emit('camo.squad.invite', { inviteId: invite.id, squadId, hostName: invite.hostName, expiresAt: invite.expiresAt });
    (this.squadPlaying.get(squadId) ?? this.squadPlaying.set(squadId, new Set()).get(squadId)!).add(userId);
    this.publishSquad(squadId);
    return { ...made, invited: invited.size };
  }

  @SubscribeMessage('camo.squad.respond')
  async squadRespond(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const inv = this.invites.get(str(data?.['inviteId']) ?? '');
    const userId = await this.who(client);
    if (!inv || !userId || !inv.invited.has(userId) || !client.rooms.has(`squad:${inv.squadId}`)) return { ok: false, reason: 'unknown_code' };
    if (data?.['accept'] !== true) {
      inv.invited.delete(userId);
      return { ok: true, declined: true };
    }
    if (Date.now() > inv.expiresAt + 20_000) return { ok: false, reason: 'unknown_code' };
    const joined = (await this.joinWith(client, (u) => this.camo.host.joinPrivate(u, inv.code))) as JoinResult;
    if (joined.ok) {
      this.squadPlaying.get(inv.squadId)?.add(userId);
      this.publishSquad(inv.squadId);
    }
    return joined;
  }

  // ── moderation (section 17a): votes, host powers, reports. Seats are named by eid, never by user id. ──

  @SubscribeMessage('camo.vote.start')
  async voteStart(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const eid = str(data?.['eid']);
    const kind = data?.['kind'] === 'kick' ? 'kick' : data?.['kind'] === 'mute' ? 'mute' : null;
    return this.input(client, (userId) => (eid && kind ? this.camo.host.voteStart(userId, eid, kind) : { ok: false, reason: 'unknown' }));
  }

  @SubscribeMessage('camo.vote.cast')
  async voteCast(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const id = str(data?.['voteId']);
    return this.input(client, (userId) => ({ ok: !!id && this.camo.host.voteCast(userId, id, data?.['yes'] === true) }));
  }

  @SubscribeMessage('camo.host.act')
  async hostAct(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const eid = str(data?.['eid']);
    const a = data?.['action'];
    const action = a === 'mute' || a === 'kick' || a === 'ban' ? a : null;
    return this.input(client, (userId) => ({ ok: !!eid && !!action && this.camo.host.hostAct(userId, eid, action) }));
  }

  @SubscribeMessage('camo.speaking')
  async speaking(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<void> {
    await this.input(client, (userId) => this.camo.host.setSpeaking(userId, data?.['on'] === true));
  }

  @SubscribeMessage('camo.mute.local')
  async muteLocal(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const eid = str(data?.['eid']);
    return this.input(client, (userId) => {
      if (eid) this.camo.host.setLocalMute(userId, eid, data?.['on'] === true);
      return { ok: !!eid };
    });
  }

  @SubscribeMessage('camo.block')
  async block(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const userId = await this.who(client);
    const eid = str(data?.['eid']);
    if (!userId || !this.owns(userId, client) || !eid) return { ok: false };
    return this.camo.moderation.blockSeat(this.camo.host, userId, eid).catch(() => ({ ok: false }));
  }

  @SubscribeMessage('camo.report')
  async report(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const userId = await this.who(client);
    const eid = str(data?.['eid']);
    const reason = str(data?.['reason']);
    if (!userId || !this.owns(userId, client) || !eid || !reason) return { ok: false, reason: 'unknown' };
    return this.camo.moderation.report(this.camo.host, userId, { eid, reason, note: str(data?.['note'], 300) ?? undefined }).catch(() => ({ ok: false, reason: 'error' }));
  }

  // ── puzzles: link challenges and the daily Chameleon (section 13) ──────────────────────────

  @SubscribeMessage('camo.creator.start')
  async creatorStart(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const roomId = str(data?.['roomId']) ?? 'locker_room';
    return this.joinWith(client, (u) => this.camo.host.startCreator(u, roomId));
  }

  @SubscribeMessage('camo.challenge.make')
  async challengeMake(@ConnectedSocket() client: Socket): Promise<unknown> {
    const userId = await this.who(client);
    if (!userId || !this.owns(userId, client)) return { ok: false, reason: 'not_ready' };
    return this.camo.puzzles.createChallenge(this.camo.host, userId).catch(() => ({ ok: false, reason: 'error' }));
  }

  @SubscribeMessage('camo.puzzle.start')
  async puzzleStart(@ConnectedSocket() client: Socket, @MessageBody() data: Body): Promise<unknown> {
    const id = str(data?.['id'], 40);
    const userId = await this.who(client);
    if (!userId || !this.owns(userId, client) || !id) return { ok: false, reason: 'not_ready' };
    const drain = this.camo.drainResult();
    if (drain) return drain;
    const user = await this.camo.userFor(userId);
    if (!user) return { ok: false, reason: 'denied' };
    await this.camo.prepare(userId);
    return this.camo.puzzles.start(this.camo.host, user, id).catch(() => ({ ok: false, reason: 'error' }));
  }

  @SubscribeMessage('camo.daily.start')
  async dailyStart(@ConnectedSocket() client: Socket): Promise<unknown> {
    const userId = await this.who(client);
    if (!userId || !this.owns(userId, client)) return { ok: false, reason: 'not_ready' };
    if (!camoDailyEnabled(this.camo.flags)) return { ok: false, reason: 'disabled' };
    const user = await this.camo.userFor(userId);
    if (!user) return { ok: false, reason: 'denied' };
    await this.camo.prepare(userId);
    const today = await this.camo.puzzles.today(this.camo.host);
    return this.camo.puzzles.start(this.camo.host, user, today.id).catch(() => ({ ok: false, reason: 'error' }));
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
    if (userId && this.owns(userId, client)) {
      this.camo.host.leave(userId);
      for (const squadId of [...this.squadPlaying.keys()]) if (this.squadPlaying.get(squadId)?.has(userId)) this.publishSquad(squadId);
    }
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
