/**
 * Runs every live match of «استغماية»: matchmaking, private rooms, inputs, the 10 Hz tick and the per-recipient fan-out.
 * No Nest, no sockets, no database: it talks to a `HostSink` and calls hooks, so the load script and the specs drive
 * it with a fake clock. One API instance holds all rooms in memory (`RoomStore` is the seam for a later Redis move).
 */
import { CAMO_PROTOCOL_VERSION, MAX_PLAYERS, MIN_PLAYERS, TIMERS, TAUNT, TICK_MS } from './camo-constants';
import { BotBrain, BOT_NAMES_AR } from './camo-bots';
import { M2_ROOMS } from './camo-rooms-m2';
import { isWalkable, buildWalkGrid, generateLockerRoom, type CamoRoomData, type WalkGrid } from './camo-room';
import { MAX_STROKES_PER_PLAYER, decodeStrokes, encodeStrokes } from './camo-paint';
import {
  acceptKick,
  acceptMove,
  acceptPaint,
  resetPaint,
  acceptScan,
  acceptTag,
  acceptTaunt,
  acceptWhistle,
  addPlayer,
  beginTouchUp,
  createMatch,
  fillWithBots,
  hidersAlive,
  playerById,
  playerByUser,
  ranking,
  setFreeze,
  setPose,
  startRound,
  step,
  voteVarSkip,
  type CamoEvent,
  type CamoMatch,
  type CamoPlayer,
  type PuzzleState,
} from './camo-rules';
import { SPEAKING_HOLD_MS, voiceMapFor } from './camo-voice';
import { castVote, logEvent, recentLog, startVote, stepVotes, tally, type RoomVote, type StartDenied, type VoteKind, type VoteResult, type VoteSettings } from './camo-moderation';
import { paintTargets, playersFor, positionsFor, stateFor, varPayload, viewerOf } from './camo-views';

export interface CamoUser {
  userId: string;
  name: string;
  morphId: string;
  guest: boolean;
  look?: unknown;
  deviceId?: string | null;
  partyId?: string | null;
}

export interface HostSink {
  emit(userId: string, event: string, payload: unknown, volatile?: boolean): void;
}

export interface HostPolicy {
  /** Two users must not meet in a public match (a block, or a 24 h vote-kick avoidance). */
  avoid(a: string, b: string): boolean;
  /** Reasons a user may not play right now (camo ban, suspended account, …); null = allowed. */
  denied(userId: string): string | null;
}

export const DEFAULT_VOTES: VoteSettings = { muteVoteSeconds: 20, muteVoteMinYes: 2, kickVotePct: 0.6, kickVoteMinYes: 3, voteCooldownSeconds: 180, noVoteLastSeconds: 20 };

export type ModerationEvent =
  | { type: 'vote.start'; matchId: string; voteId: string; kind: VoteKind; by: string; target: string }
  | { type: 'vote.end'; matchId: string; voteId: string; kind: VoteKind; passed: boolean; yes: string[]; target: string; by: string }
  | { type: 'mute'; matchId: string; target: string; by: string | 'vote' }
  | { type: 'kick'; matchId: string; target: string; by: string | 'vote'; voters: string[]; ban: boolean };

export interface HostOptions {
  maxMatches: number;
  now: () => number;
  sink: HostSink;
  policy?: HostPolicy;
  onMatchEnd?: (m: CamoMatch) => void;
  onMatchOpen?: (m: CamoMatch) => void;
  /** Only the room ids the owner enabled; default: the locker room. */
  rooms?: () => readonly string[];
  /** Whether proximity voice is on (the flag). */
  voiceOn?: () => boolean;
  /** Vote numbers (section 17a); the admin settings feed this. */
  votes?: () => VoteSettings;
  /** Everything a moderator or the audit log wants to know (votes, kicks, mutes); the host never touches a database. */
  onModeration?: (e: ModerationEvent) => void;
  /** Sleeps the wait for a public lobby (tests). */
  waitMs?: number;
}

export type JoinResult =
  | { ok: true; matchId: string; code?: string }
  | { ok: false; reason: 'busy' | 'drain' | 'denied' | 'full' | 'locked' | 'banned' | 'unknown_code' | 'in_match' | 'protocol'; detail?: string };

class Bucket {
  private tokens: number;
  private at: number;
  constructor(private readonly perSecond: number, private readonly burst: number, now: number) {
    this.tokens = burst;
    this.at = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export const INPUT_RATES: Readonly<Record<string, [number, number]>> = Object.freeze({
  move: [20, 30],
  paint: [6, 10],
  pose: [4, 6],
  freeze: [4, 6],
  kick: [3, 4],
  tag: [3, 4],
  whistle: [1, 2],
  scan: [1, 2],
  taunt: [1, 2],
  emoji: [0.5, 5],
  speaking: [4, 8],
});

const AFK_WARN_MS = 25_000;
const AFK_COVER_MS = 35_000;
const EMPTY_CLOSE_MS = 5 * 60_000;
const LEAVE_WINDOW_MS = 60 * 60_000;
const LEAVE_LIMIT = 3;
const LEAVE_WAIT_MS = 2 * 60_000;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export class CamoHost {
  readonly matches = new Map<string, CamoMatch>();
  private readonly byUser = new Map<string, string>();
  private readonly byCode = new Map<string, string>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly brains = new Map<string, BotBrain>();
  private readonly leaves = new Map<string, number[]>();
  private readonly waitUntil = new Map<string, number>();
  private readonly afkWarned = new Set<string>();
  private readonly rooms = new Map<string, { room: CamoRoomData; grid: WalkGrid }>();
  private readonly emptySince = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private seq = 1;
  private lastBroadcast = new Map<string, number>();
  private lastVoice = new Map<string, number>();

  constructor(private readonly o: HostOptions) {
    for (const make of [generateLockerRoom, ...M2_ROOMS]) {
      const room = make();
      this.rooms.set(room.id, { room, grid: buildWalkGrid(room) });
    }
  }

  get now(): number {
    return this.o.now();
  }

  roomData(id: string): CamoRoomData | undefined {
    return this.rooms.get(id)?.room;
  }

  get activeMatches(): number {
    return this.matches.size;
  }

  get humanCount(): number {
    let n = 0;
    for (const m of this.matches.values()) for (const p of m.players) if (!p.isBot && p.connected) n++;
    return n;
  }

  matchOf(userId: string): CamoMatch | null {
    const id = this.byUser.get(userId);
    return id ? (this.matches.get(id) ?? null) : null;
  }

  isPlaying(userId: string): boolean {
    return this.byUser.has(userId);
  }

  // ── timing ────────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(this.now), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── joining ───────────────────────────────────────────────────────────────

  private rate(userId: string, kind: string, now: number): boolean {
    const spec = INPUT_RATES[kind];
    if (!spec) return true;
    const key = `${userId}:${kind}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = new Bucket(spec[0], spec[1], now);
      this.buckets.set(key, b);
    }
    return b.take(now);
  }

  hello(protocolVersion: unknown): { ok: boolean; serverVersion: number } {
    return { ok: protocolVersion === CAMO_PROTOCOL_VERSION, serverVersion: CAMO_PROTOCOL_VERSION };
  }

  private newCode(): string {
    for (let tries = 0; tries < 50; tries++) {
      let c = '';
      for (let i = 0; i < 5; i++) c += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
      if (!this.byCode.has(c)) return c;
    }
    return `${Date.now().toString(36).slice(-5).toUpperCase()}`;
  }

  private denyJoin(u: CamoUser, now: number): JoinResult | null {
    if (this.byUser.has(u.userId)) return { ok: false, reason: 'in_match' };
    const why = this.o.policy?.denied(u.userId);
    if (why) return { ok: false, reason: 'denied', detail: why };
    const hist = (this.leaves.get(u.userId) ?? []).filter((t) => now - t < LEAVE_WINDOW_MS);
    if (hist.length >= LEAVE_LIMIT && now - hist[hist.length - 1] < LEAVE_WAIT_MS) {
      return { ok: false, reason: 'denied', detail: 'wait_after_leaving' };
    }
    return null;
  }

  private spawnMatch(roomId: string, opts: { isPrivate?: boolean; hostId?: string | null; mode?: 'classic' | 'contagion'; timers?: { prepMs?: number; huntMs?: number }; botTarget?: number; botsAllowed?: boolean }): CamoMatch | null {
    if (this.matches.size >= this.o.maxMatches) return null;
    const now = this.now;
    const id = `cm${this.seq++}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const code = opts.isPrivate ? this.newCode() : null;
    const m = createMatch({
      id,
      room: this.rooms.get(roomId)!.room,
      mode: opts.mode,
      isPrivate: opts.isPrivate,
      code,
      hostId: opts.hostId ?? null,
      timers: opts.timers,
      botsAllowed: opts.botsAllowed,
      botTarget: opts.botTarget,
      seed: Math.floor(Math.random() * 0xffffffff),
      now,
    });
    m.phaseEndsAt = now + (this.o.waitMs ?? TIMERS.waitingMaxMs);
    this.matches.set(id, m);
    if (code) this.byCode.set(code, id);
    this.brains.set(id, new BotBrain(this.rooms.get(roomId)!.room, this.rooms.get(roomId)!.grid));
    this.o.onMatchOpen?.(m);
    return m;
  }

  private place(m: CamoMatch, u: CamoUser, now: number): CamoPlayer | null {
    const p = addPlayer(m, { userId: u.userId, name: u.name, isBot: false, morphId: u.morphId, guest: u.guest, look: u.look, partyId: u.partyId ?? null, deviceId: u.deviceId ?? null }, now);
    if (!p) return null;
    this.byUser.set(u.userId, m.id);
    this.emptySince.delete(m.id);
    // a latecomer to a running match watches until the next round, then a bot gives way (section 20c)
    if (m.phase !== 'waiting') {
      p.role = 'spectator';
      p.alive = false;
      p.loaded = true;
    }
    this.sendSnapshot(m, p);
    this.broadcastRoster(m);
    return p;
  }

  /** A public match: the first open one the player is allowed in, else a fresh one. */
  joinPublic(u: CamoUser, roomId: string | 'any' = 'any', now = this.now): JoinResult {
    const denied = this.denyJoin(u, now);
    if (denied) return denied;
    const open = (this.o.rooms?.() ?? ['locker_room']).filter((id) => this.rooms.has(id));
    const room = roomId === 'any' ? (open[Math.floor(Math.random() * open.length)] ?? 'locker_room') : roomId;
    if (!this.rooms.has(room) || (roomId !== 'any' && !open.includes(room))) return { ok: false, reason: 'unknown_code', detail: 'room' };
    for (const m of this.matches.values()) {
      if (m.isPrivate || m.phase !== 'waiting' || m.roomId !== room || m.players.length >= MAX_PLAYERS || m.locked) continue;
      if (m.players.some((p) => p.userId && this.o.policy?.avoid(u.userId, p.userId))) continue;
      const p = this.place(m, u, now);
      if (p) return { ok: true, matchId: m.id };
    }
    const m = this.spawnMatch(room, {});
    if (!m) return { ok: false, reason: 'busy' };
    const p = this.place(m, u, now);
    return p ? { ok: true, matchId: m.id } : { ok: false, reason: 'full' };
  }

  joinMatchById(u: CamoUser, matchId: string, now = this.now): JoinResult {
    const denied = this.denyJoin(u, now);
    if (denied) return denied;
    const m = this.matches.get(matchId);
    if (!m) return { ok: false, reason: 'unknown_code' };
    return this.joinExisting(m, u, now);
  }

  private joinExisting(m: CamoMatch, u: CamoUser, now: number): JoinResult {
    if (m.banned.has(u.userId)) return { ok: false, reason: 'banned' };
    if (m.locked) return { ok: false, reason: 'locked' };
    if (m.players.filter((p) => !p.isBot).length >= MAX_PLAYERS) return { ok: false, reason: 'full' };
    // bots give way to humans
    if (m.players.length >= MAX_PLAYERS) {
      const bot = m.players.find((p) => p.isBot && p.role !== 'seeker');
      if (!bot) return { ok: false, reason: 'full' };
      m.players.splice(m.players.indexOf(bot), 1);
    }
    const p = this.place(m, u, now);
    return p ? { ok: true, matchId: m.id, code: m.code ?? undefined } : { ok: false, reason: 'full' };
  }

  createPrivate(u: CamoUser, opts: { roomId?: string; mode?: 'classic' | 'contagion'; prepSeconds?: number; huntSeconds?: number; bots?: number } = {}, now = this.now): JoinResult {
    const denied = this.denyJoin(u, now);
    if (denied) return denied;
    const enabled = this.o.rooms?.() ?? ['locker_room'];
    const roomId = this.rooms.has(opts.roomId ?? '') && enabled.includes(opts.roomId!) ? opts.roomId! : 'locker_room';
    const bots = Math.min(MAX_PLAYERS - 1, Math.max(0, Math.floor(opts.bots ?? 5)));
    const m = this.spawnMatch(roomId, {
      isPrivate: true,
      hostId: u.userId,
      mode: opts.mode,
      timers: { prepMs: (opts.prepSeconds ?? 60) * 1000, huntMs: (opts.huntSeconds ?? 180) * 1000 },
      botsAllowed: bots > 0,
      botTarget: bots + 1,
    });
    if (!m) return { ok: false, reason: 'busy' };
    m.phaseEndsAt = Number.MAX_SAFE_INTEGER; // a private room waits for the host
    const p = this.place(m, u, now);
    return p ? { ok: true, matchId: m.id, code: m.code ?? undefined } : { ok: false, reason: 'full' };
  }

  joinPrivate(u: CamoUser, code: string, now = this.now): JoinResult {
    const denied = this.denyJoin(u, now);
    if (denied) return denied;
    const id = this.byCode.get(String(code ?? '').trim().toUpperCase());
    const m = id ? this.matches.get(id) : undefined;
    if (!m) return { ok: false, reason: 'unknown_code' };
    return this.joinExisting(m, u, now);
  }

  /** Host of a private room presses «ابدأ»: bots fill, the first round begins. */
  /** Starts a one-seeker puzzle (link challenge / daily): the human seeks one painted, motionless bot for 60 s with 3 misses. */
  startPuzzle(u: CamoUser, pz: Omit<PuzzleState, 'misses' | 'failed' | 'foundMs' | 'maxMisses'> & { roomId: string; creatorName?: string }, now = this.now): JoinResult {
    const denied = this.denyJoin(u, now);
    if (denied) return denied;
    if (!this.rooms.has(pz.roomId)) return { ok: false, reason: 'unknown_code', detail: 'room' };
    const m = this.spawnMatch(pz.roomId, { isPrivate: true, hostId: u.userId, botsAllowed: false });
    if (!m) return { ok: false, reason: 'busy' };
    m.locked = true;
    m.timers.prepMs = 4_000;
    m.timers.huntMs = 60_000;
    if (!this.place(m, u, now)) return { ok: false, reason: 'full' };
    addPlayer(m, { userId: null, name: pz.creatorName || '?', isBot: true, morphId: pz.morphId }, now);
    m.puzzle = { puzzleId: pz.puzzleId, x: pz.x, z: pz.z, yaw: pz.yaw, pose: pz.pose, strokes: pz.strokes, morphId: pz.morphId, maxMisses: 3, misses: 0, failed: false, foundMs: null };
    startRound(m, this.rooms.get(m.roomId)!.room, now);
    this.afterOutbox(m, now);
    return { ok: true, matchId: m.id };
  }

  /** A challenge creator hides alone in a locked room (90 s of preparation, no seekers). */
  startCreator(u: CamoUser, roomId: string, now = this.now): JoinResult {
    const denied = this.denyJoin(u, now);
    if (denied) return denied;
    if (!this.rooms.has(roomId)) return { ok: false, reason: 'unknown_code', detail: 'room' };
    const m = this.spawnMatch(roomId, { isPrivate: true, hostId: u.userId, botsAllowed: false });
    if (!m) return { ok: false, reason: 'busy' };
    m.locked = true;
    m.creator = true;
    m.timers.prepMs = 90_000;
    if (!this.place(m, u, now)) return { ok: false, reason: 'full' };
    startRound(m, this.rooms.get(m.roomId)!.room, now);
    this.afterOutbox(m, now);
    return { ok: true, matchId: m.id };
  }

  /** What the creator is hiding as right now, checked: inside the room, on free floor, outside the referees' zone. */
  creatorSnapshot(userId: string): { roomId: string; x: number; z: number; yaw: number; pose: string; morphId: string; strokes: PuzzleState['strokes'] } | null {
    const m = this.matchOf(userId);
    const p = m && playerByUser(m, userId);
    if (!m || !m.creator || !p || m.phase !== 'prep') return null;
    const room = this.rooms.get(m.roomId)!.room;
    if (!isWalkable(room, p.x, p.z, 0.2) || room.forbidden.some((f) => p.x >= f.minX && p.x <= f.maxX && p.z >= f.minZ && p.z <= f.maxZ)) return null;
    return { roomId: m.roomId, x: p.x, z: p.z, yaw: p.yaw, pose: p.pose, morphId: p.morphId, strokes: [...p.paint.strokes] };
  }

  hostStart(userId: string, now = this.now): boolean {
    const m = this.matchOf(userId);
    if (!m || !m.isPrivate || m.hostId !== userId || m.phase !== 'waiting') return false;
    this.beginMatch(m, now);
    return true;
  }

  hostLock(userId: string, locked: boolean): boolean {
    const m = this.matchOf(userId);
    if (!m || m.hostId !== userId) return false;
    m.locked = locked;
    this.broadcastState(m, this.now);
    return true;
  }

  hostRotateCode(userId: string): string | null {
    const m = this.matchOf(userId);
    if (!m || !m.isPrivate || m.hostId !== userId || !m.code) return null;
    this.byCode.delete(m.code);
    m.code = this.newCode();
    this.byCode.set(m.code, m.id);
    this.broadcastState(m, this.now);
    return m.code;
  }

  private beginMatch(m: CamoMatch, now: number): void {
    const room = this.rooms.get(m.roomId)!.room;
    if (m.botsAllowed) fillWithBots(m, now, (i) => BOT_NAMES_AR[(i * 7 + Math.floor(m.rng() * 200)) % BOT_NAMES_AR.length], ['potato', 'banana', 'penguin', 'camel', 'keeper', 'referee', 'dino', 'robot', 'ultra', 'gamer', 'cactus', 'ghost', 'taameya', 'classic']);
    if (m.players.length < MIN_PLAYERS) {
      // too few people and no bots: wait for more
      m.phaseEndsAt = now + 5_000;
      return;
    }
    startRound(m, room, now);
    this.afterOutbox(m, now);
  }

  // ── leaving ───────────────────────────────────────────────────────────────

  leave(userId: string, now = this.now, voluntary = true): void {
    const m = this.matchOf(userId);
    if (!m) return;
    const p = playerByUser(m, userId);
    this.byUser.delete(userId);
    if (!p) return;
    p.connected = false;
    p.heldUntil = now; // a bot takes over at the next tick
    if (voluntary && m.phase !== 'waiting' && !m.isPrivate) {
      const list = (this.leaves.get(userId) ?? []).filter((t) => now - t < LEAVE_WINDOW_MS);
      list.push(now);
      this.leaves.set(userId, list);
    }
    if (m.phase === 'waiting') m.players.splice(m.players.indexOf(p), 1);
    if (m.hostId === userId) this.transferHost(m);
    this.broadcastRoster(m);
  }

  /** The socket dropped: hold the seat for 20 s (section 20c), a bot plays meanwhile after that. */
  disconnect(userId: string, now = this.now): void {
    const m = this.matchOf(userId);
    if (!m) return;
    const p = playerByUser(m, userId);
    if (!p) return;
    if (m.phase === 'waiting') {
      this.leave(userId, now, false);
      return;
    }
    p.connected = false;
    p.heldUntil = now + TIMERS.reconnectHoldMs;
  }

  /** Same user, new socket: back into the same round with the whole picture. */
  reconnect(userId: string): boolean {
    const m = this.matchOf(userId);
    if (!m) return false;
    const p = playerByUser(m, userId);
    if (!p) return false;
    p.connected = true;
    p.heldUntil = 0;
    p.botCover = false;
    p.lastInputAt = this.now;
    this.sendSnapshot(m, p);
    return true;
  }

  private transferHost(m: CamoMatch): void {
    const next = m.players.filter((p) => !p.isBot && p.connected).sort((a, b) => a.eid.localeCompare(b.eid))[0];
    m.hostId = next?.userId ?? null;
    if (!next && m.isPrivate) this.emptySince.set(m.id, this.now);
  }

  // ── inputs (called by the gateway with the user id from the socket) ─────────

  private ctx(userId: string, kind: string, now: number): { m: CamoMatch; p: CamoPlayer; room: CamoRoomData } | null {
    if (!this.rate(userId, kind, now)) return null;
    const m = this.matchOf(userId);
    if (!m) return null;
    const p = playerByUser(m, userId);
    if (!p) return null;
    // A human who acts takes the seat back from the bot that covered for them.
    if (p.botCover && p.connected) p.botCover = false;
    return { m, p, room: this.rooms.get(m.roomId)!.room };
  }

  move(userId: string, mv: { x: number; z: number; yaw: number; vx: number; vz: number; seq: number; run?: boolean }, now = this.now) {
    const c = this.ctx(userId, 'move', now);
    if (!c) return null;
    c.p.loaded = true;
    return acceptMove(c.m, c.room, c.p.eid, mv, now);
  }

  pose(userId: string, pose: string, now = this.now): boolean {
    const c = this.ctx(userId, 'pose', now);
    if (!c) return false;
    const ok = setPose(c.m, c.p.eid, pose, now);
    if (ok) this.fanPose(c.m, c.p);
    return ok;
  }

  freeze(userId: string, on: boolean, now = this.now): boolean {
    const c = this.ctx(userId, 'freeze', now);
    return c ? setFreeze(c.m, c.room, c.p.eid, on, now) : false;
  }

  paint(userId: string, bytes: unknown, now = this.now): { accepted: number; rejected: number } | null {
    const c = this.ctx(userId, 'paint', now);
    if (!c) return null;
    const raw = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Array.isArray(bytes) ? Uint8Array.from(bytes as number[]) : null;
    const strokes = raw ? decodeStrokes(raw) : null;
    if (!strokes) return null;
    const v = acceptPaint(c.m, c.p.eid, strokes, now);
    if (!v) return null;
    if (v.accepted.length) this.fanPaint(c.m, c.p, v.accepted, now);
    return { accepted: v.accepted.length, rejected: v.rejected };
  }

  /** Undo/clear on the client: the whole stroke list replaces the player's paint, and everybody gets a fresh snapshot. */
  paintReset(userId: string, bytes: unknown, now = this.now): { accepted: number; rejected: number } | null {
    const c = this.ctx(userId, 'paint', now);
    if (!c) return null;
    const raw = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Array.isArray(bytes) ? Uint8Array.from(bytes as number[]) : null;
    const strokes = raw ? decodeStrokes(raw, MAX_STROKES_PER_PLAYER) : null;
    if (!strokes) return null;
    const v = resetPaint(c.m, c.p.eid, strokes, now);
    if (!v) return null;
    for (const p of this.humans(c.m)) {
      if (p === c.p) continue;
      if (paintTargets(c.m, viewerOf(p)).includes(c.p)) this.sendPaint(p.userId!, c.p);
    }
    return { accepted: v.accepted.length, rejected: v.rejected };
  }

  touchUp(userId: string, now = this.now): boolean {
    const c = this.ctx(userId, 'paint', now);
    return c ? beginTouchUp(c.m, c.p.eid, now) : false;
  }

  kick(userId: string, k: { origin: { x: number; y: number; z: number }; dir: [number, number, number]; power: number; lob: boolean; seq: number }, now = this.now) {
    const c = this.ctx(userId, 'kick', now);
    if (!c) return null;
    const r = acceptKick(c.m, c.room, c.p.eid, k, now);
    this.afterOutbox(c.m, now);
    return r;
  }

  tag(userId: string, now = this.now) {
    const c = this.ctx(userId, 'tag', now);
    if (!c) return null;
    const r = acceptTag(c.m, c.p.eid, now);
    this.afterOutbox(c.m, now);
    return r;
  }

  whistle(userId: string, now = this.now): boolean {
    const c = this.ctx(userId, 'whistle', now);
    if (!c) return false;
    const ok = acceptWhistle(c.m, c.p.eid, now);
    this.afterOutbox(c.m, now);
    return ok;
  }

  scan(userId: string, now = this.now, enabled = true): boolean {
    const c = this.ctx(userId, 'scan', now);
    if (!c) return false;
    const ok = acceptScan(c.m, c.p.eid, now, enabled);
    this.afterOutbox(c.m, now);
    return ok;
  }

  taunt(userId: string, now = this.now): boolean {
    const c = this.ctx(userId, 'taunt', now);
    if (!c) return false;
    const ok = acceptTaunt(c.m, c.p.eid, now);
    this.afterOutbox(c.m, now);
    return ok;
  }

  varSkip(userId: string): void {
    const m = this.matchOf(userId);
    if (m) voteVarSkip(m, userId);
  }

  /** «كمان ماتش»: same room and people, a fresh 3-round match. */
  rematch(userId: string, now = this.now): boolean {
    const m = this.matchOf(userId);
    if (!m || m.phase !== 'ended') return false;
    const room = this.rooms.get(m.roomId)!.room;
    for (const p of m.players) {
      p.total = 0;
      p.seekerRounds = 0;
      p.match = { roles: [], caught: 0, cardsGiven: 0, yellows: 0, bestSurvivalMs: 0, awards: [] };
    }
    m.round = 0;
    m.rounds = [];
    m.phase = 'waiting';
    m.endedAt = null;
    startRound(m, room, now);
    this.afterOutbox(m, now);
    return true;
  }

  // ── the tick ──────────────────────────────────────────────────────────────

  tick(now = this.now): void {
    for (const m of [...this.matches.values()]) {
      const entry = this.rooms.get(m.roomId);
      if (!entry) continue;
      if (m.phase === 'waiting' && !m.isPrivate) {
        const humansIn = m.players.filter((p) => !p.isBot).length;
        if (now >= m.phaseEndsAt || humansIn >= (m.botTarget || 8)) this.beginMatch(m, now);
        this.dropIfEmpty(m, now);
        this.broadcastVoice(m, now);
        continue;
      }
      if (m.phase === 'waiting') {
        if (m.hostId === null) this.dropIfEmpty(m, now);
        this.broadcastVoice(m, now);
        continue;
      }
      if (m.phase === 'ended') continue;
      this.watchAfk(m, now);
      this.stepModeration(m, now);
      this.brains.get(m.id)?.tick(m, now);
      const alive = step(m, entry.room, now);
      this.afterOutbox(m, now);
      if ((m.phase as string) !== 'ended') this.broadcastPositions(m, entry.room, now);
      this.broadcastVoice(m, now);
      if (!alive) this.finish(m, now);
      else this.dropIfEmpty(m, now);
    }
  }

  private dropIfEmpty(m: CamoMatch, now: number): void {
    const humans = m.players.filter((p) => !p.isBot && (p.connected || p.heldUntil > now));
    if (humans.length) {
      this.emptySince.delete(m.id);
      return;
    }
    // Nobody left: a public lobby goes at once; a running match or a private room waits a little for people to return.
    const grace = m.phase === 'waiting' && !m.isPrivate ? 0 : m.phase === 'waiting' ? EMPTY_CLOSE_MS : 120_000;
    const since = this.emptySince.get(m.id) ?? now;
    this.emptySince.set(m.id, since);
    if (now - since >= grace) this.closeMatch(m);
  }

  private watchAfk(m: CamoMatch, now: number): void {
    if (m.phase !== 'hunt') return;
    for (const p of m.players) {
      if (p.isBot || p.botCover || p.role !== 'seeker' || !p.connected || !p.userId) continue;
      const idle = now - p.lastInputAt;
      if (idle >= AFK_COVER_MS) {
        p.botCover = true;
        this.o.sink.emit(p.userId, 'camo.afk', { state: 'covered' });
      } else if (idle >= AFK_WARN_MS && !this.afkWarned.has(p.eid)) {
        this.afkWarned.add(p.eid);
        this.o.sink.emit(p.userId, 'camo.afk', { state: 'warn', inMs: AFK_COVER_MS - idle });
      } else if (idle < AFK_WARN_MS) this.afkWarned.delete(p.eid);
    }
  }

  private finish(m: CamoMatch, now: number): void {
    const board = ranking(m);
    const names = new Map(m.players.map((p) => [p.eid, p]));
    const payload = {
      matchId: m.id,
      ranking: board.map((r) => ({ ...r, name: names.get(r.eid)?.name, userId: names.get(r.eid)?.userId ?? null, isBot: names.get(r.eid)?.isBot ?? false, morphId: names.get(r.eid)?.morphId })),
      rounds: m.rounds.map((r) => ({ round: r.round, winner: r.winner, awards: r.awards })),
    };
    for (const p of m.players) if (p.userId && !p.isBot && p.connected) this.o.sink.emit(p.userId, 'camo.match.result', payload);
    this.o.onMatchEnd?.(m);
    // keep the finished match for «كمان ماتش» for a minute; then it goes
    setTimeout(() => {
      if (m.phase === 'ended') this.closeMatch(m);
    }, 60_000).unref?.();
    void now;
  }

  closeMatch(m: CamoMatch): void {
    for (const p of m.players) if (p.userId && this.byUser.get(p.userId) === m.id) this.byUser.delete(p.userId);
    if (m.code) this.byCode.delete(m.code);
    this.matches.delete(m.id);
    this.brains.delete(m.id);
    this.emptySince.delete(m.id);
  }

  dispose(): void {
    this.stop();
    this.matches.clear();
    this.byUser.clear();
    this.byCode.clear();
    this.brains.clear();
  }

  // ── fan-out ───────────────────────────────────────────────────────────────

  private humans(m: CamoMatch): CamoPlayer[] {
    return m.players.filter((p) => !p.isBot && p.userId && p.connected);
  }

  private broadcastState(m: CamoMatch, now: number): void {
    for (const p of this.humans(m)) this.o.sink.emit(p.userId!, 'camo.match.state', stateFor(m, viewerOf(p), now));
  }

  private broadcastRoster(m: CamoMatch): void {
    for (const p of this.humans(m)) this.o.sink.emit(p.userId!, 'camo.players', playersFor(m, viewerOf(p)));
    this.broadcastState(m, this.now);
  }

  // ── proximity voice (section 10): the server says who hears whom ──────────────────────────

  setSpeaking(userId: string, on: boolean, now = this.now): void {
    const m = this.matchOf(userId);
    const p = m && playerByUser(m, userId);
    if (!p || !this.rate(userId, 'speaking', now)) return;
    p.speakingUntil = on && !m.mod.muted.has(userId) ? now + SPEAKING_HOLD_MS : 0;
  }

  /** «اكتمه عندي»: kept on the server so the voice map drops them and the room's links to them close. */
  setLocalMute(userId: string, eid: string, on: boolean): void {
    const m = this.matchOf(userId);
    const p = m && playerByUser(m, userId);
    if (!p || !m.players.some((x) => x.eid === eid)) return;
    if (on) p.localMuted.add(eid);
    else p.localMuted.delete(eid);
  }

  /** Not volatile: a volatile packet sent right after the positions in the same tick is dropped by socket.io (the transport is busy). */
  private broadcastVoice(m: CamoMatch, now: number): void {
    if (this.o.voiceOn && !this.o.voiceOn()) return;
    if (now - (this.lastVoice.get(m.id) ?? 0) < 200) return;
    this.lastVoice.set(m.id, now);
    const scope = `camo:${m.id}`;
    for (const p of this.humans(m)) {
      const map = voiceMapFor(m, p, now);
      this.o.sink.emit(p.userId!, 'camo.voice', { scope, t: now, peers: map.peers.map((e) => [e.userId, Math.round(e.gain * 100) / 100, e.x === undefined ? null : Math.round(e.x * 10) / 10, e.z === undefined ? null : Math.round((e.z as number) * 10) / 10]), connect: map.connect, phase: m.phase });
    }
  }

  // ── moderation (section 17a) ─────────────────────────────────────────────────

  private get voteCfg(): VoteSettings {
    return this.o.votes?.() ?? DEFAULT_VOTES;
  }

  private voteView(m: CamoMatch, v: RoomVote): unknown {
    const t = tally(m, v, this.voteCfg);
    const target = m.players.find((p) => p.eid === v.targetEid);
    return { id: v.id, kind: v.kind, eid: v.targetEid, name: target?.name, endsAt: v.endsAt, yes: t.yes, no: t.no, needed: t.needed, groups: t.groups };
  }

  voteStart(userId: string, eid: string, kind: VoteKind, now = this.now): { ok: true; voteId: string } | { ok: false; reason: StartDenied | 'not_in_room' } {
    const m = this.matchOf(userId);
    if (!m) return { ok: false, reason: 'not_in_room' };
    const r = startVote(m, userId, eid, kind, this.voteCfg, now);
    if (!r.ok) return r;
    logEvent(m, 'vote.start', { kind, target: r.vote.targetEid }, now);
    this.o.onModeration?.({ type: 'vote.start', matchId: m.id, voteId: r.vote.id, kind, by: userId, target: r.vote.targetUserId });
    const view = this.voteView(m, r.vote);
    for (const p of this.humans(m)) if (p.userId !== r.vote.targetUserId) this.o.sink.emit(p.userId!, 'camo.vote', view);
    return { ok: true, voteId: r.vote.id };
  }

  voteCast(userId: string, voteId: string, yes: boolean): boolean {
    const m = this.matchOf(userId);
    if (!m || !castVote(m, userId, voteId, yes)) return false;
    const v = m.mod.votes.get(voteId);
    if (v) {
      const view = this.voteView(m, v);
      for (const p of this.humans(m)) if (p.userId !== v.targetUserId) this.o.sink.emit(p.userId!, 'camo.vote', view);
    }
    return true;
  }

  isMuted(userId: string): boolean {
    const m = this.matchOf(userId);
    return !!m && m.mod.muted.has(userId);
  }

  /** The seats muted in this room (by eid), for a joining or returning client. */
  mutedEids(m: CamoMatch): string[] {
    return m.players.filter((p) => p.userId && m.mod.muted.has(p.userId)).map((p) => p.eid);
  }

  private applyMute(m: CamoMatch, userId: string, by: string): void {
    const p = playerByUser(m, userId);
    if (!p || m.mod.muted.has(userId)) return;
    m.mod.muted.add(userId);
    this.o.onModeration?.({ type: 'mute', matchId: m.id, target: userId, by });
    for (const h of this.humans(m)) this.o.sink.emit(h.userId!, 'camo.muted', { eid: p.eid, self: h.userId === userId });
  }

  private applyKick(m: CamoMatch, userId: string, by: string, voters: string[], ban: boolean, now: number): void {
    const p = playerByUser(m, userId);
    if (!p) return;
    this.o.onModeration?.({ type: 'kick', matchId: m.id, target: userId, by, voters, ban });
    if (ban) m.banned.add(userId);
    this.o.sink.emit(userId, 'camo.kicked', { reason: by === 'vote' ? 'vote' : 'host' });
    this.leave(userId, now, false);
  }

  private stepModeration(m: CamoMatch, now: number): void {
    const cfg = this.voteCfg;
    const results: VoteResult[] = stepVotes(m, cfg, now);
    for (const r of results) {
      this.o.onModeration?.({ type: 'vote.end', matchId: m.id, voteId: r.vote.id, kind: r.vote.kind, passed: r.passed, yes: r.voters, target: r.vote.targetUserId, by: r.vote.startedBy });
      const view = { ...(this.voteView(m, r.vote) as object), passed: r.passed, closed: true };
      for (const p of this.humans(m)) this.o.sink.emit(p.userId!, 'camo.vote', view);
      if (!r.passed) continue;
      if (r.vote.kind === 'mute') this.applyMute(m, r.vote.targetUserId, 'vote');
      // a kick that passes while the round is nearly over (or in the VAR) waits for the round to end
      else if (m.phase === 'var' || m.phase === 'results' || (m.phase === 'hunt' && m.phaseEndsAt - now < cfg.noVoteLastSeconds * 1000)) m.mod.deferred.push({ userId: r.vote.targetUserId, voters: r.voters });
      else this.applyKick(m, r.vote.targetUserId, 'vote', r.voters, true, now);
    }
    if (m.mod.deferred.length && (m.phase === 'results' || m.phase === 'ended')) {
      for (const d of m.mod.deferred.splice(0)) this.applyKick(m, d.userId, 'vote', d.voters, true, now);
    }
  }

  /** What a report about someone in this room carries: phase, round and the last minute of events. */
  reportContext(userId: string, now = this.now): { matchId: string; round: number; phase: string; log: unknown[] } | null {
    const m = this.matchOf(userId);
    if (!m) return null;
    return { matchId: m.id, round: m.round, phase: m.phase, log: recentLog(m, now) };
  }

  /** Who a seat (eid) is, for the viewer's own room only (reports and votes name seats, never user ids). */
  userOfEid(viewerId: string, eid: string): { userId: string; name: string; partyId: string | null } | null {
    const m = this.matchOf(viewerId);
    const p = m?.players.find((x) => x.eid === eid);
    return p?.userId && !p.isBot ? { userId: p.userId, name: p.name, partyId: p.partyId } : null;
  }

  partyOf(userId: string): string | null {
    const m = this.matchOf(userId);
    return m ? playerByUser(m, userId)?.partyId ?? null : null;
  }

  /** The running rooms for the admin tab: names and counts only, no hider positions. */
  liveRooms(): Array<{ id: string; roomId: string; private: boolean; code: string | null; phase: string; round: number; humans: Array<{ userId: string; name: string; muted: boolean; guest: boolean }>; bots: number }> {
    return [...this.matches.values()].map((m) => ({
      id: m.id,
      roomId: m.roomId,
      private: m.isPrivate,
      code: m.code,
      phase: m.phase,
      round: m.round,
      humans: m.players.filter((p) => !p.isBot && p.userId).map((p) => ({ userId: p.userId!, name: p.name, muted: m.mod.muted.has(p.userId!), guest: p.guest })),
      bots: m.players.filter((p) => p.isBot).length,
    }));
  }

  /** An admin removes someone from a live room (a bot takes the seat). */
  adminKick(matchId: string, userId: string, now = this.now): boolean {
    const m = this.matches.get(matchId);
    if (!m || !playerByUser(m, userId)) return false;
    this.applyKick(m, userId, 'admin', [], true, now);
    return true;
  }

  adminCloseRoom(matchId: string): boolean {
    const m = this.matches.get(matchId);
    if (!m) return false;
    for (const p of this.humans(m)) {
      this.o.sink.emit(p.userId!, 'camo.kicked', { reason: 'closed' });
      this.byUser.delete(p.userId!);
    }
    this.closeMatch(m);
    return true;
  }

  /** A private room's host acts directly, no vote: mute, kick, or kick and bar the way back. */
  hostAct(userId: string, eid: string, action: 'mute' | 'kick' | 'ban', now = this.now): boolean {
    const m = this.matchOf(userId);
    if (!m || !m.isPrivate || m.hostId !== userId) return false;
    const target = m.players.find((p) => p.eid === eid);
    if (!target || !target.userId || target.userId === userId || target.isBot) return false;
    if (action === 'mute') this.applyMute(m, target.userId, userId);
    else this.applyKick(m, target.userId, userId, [], action === 'ban', now);
    return true;
  }

  sendSnapshot(m: CamoMatch, p: CamoPlayer): void {
    if (!p.userId) return;
    for (const eid of this.mutedEids(m)) this.o.sink.emit(p.userId, 'camo.muted', { eid, self: m.players.find((x) => x.eid === eid)?.userId === p.userId });
    const room = this.rooms.get(m.roomId)!.room;
    const now = this.now;
    const v = viewerOf(p);
    this.o.sink.emit(p.userId, 'camo.match.state', stateFor(m, v, now));
    this.o.sink.emit(p.userId, 'camo.players', playersFor(m, v));
    this.o.sink.emit(p.userId, 'camo.positions', { t: now, p: positionsFor(m, room, v, now) }, true);
    for (const h of paintTargets(m, v)) this.sendPaint(p.userId, h);
  }

  private sendPaint(userId: string, h: CamoPlayer): void {
    const list = h.paint.strokes;
    for (let i = 0; i < list.length; i += 60) {
      this.o.sink.emit(userId, 'camo.paint.delta', { eid: h.eid, snapshot: i === 0, bytes: encodeStrokes(list.slice(i, i + 60)) });
    }
    if (!list.length) this.o.sink.emit(userId, 'camo.paint.delta', { eid: h.eid, snapshot: true, bytes: encodeStrokes([]) });
  }

  private fanPaint(m: CamoMatch, h: CamoPlayer, accepted: readonly import('./camo-paint').WireStroke[], now: number): void {
    const bytes = encodeStrokes(accepted);
    for (const p of this.humans(m)) {
      if (p === h) continue; // the painter already drew it locally
      const v = viewerOf(p);
      if (!paintTargets(m, v).includes(h)) continue;
      this.o.sink.emit(p.userId!, 'camo.paint.delta', { eid: h.eid, bytes });
    }
    void now;
  }

  private fanPose(m: CamoMatch, h: CamoPlayer): void {
    for (const p of this.humans(m)) this.o.sink.emit(p.userId!, 'camo.pose.state', { eid: h.eid, pose: h.pose });
  }

  private broadcastPositions(m: CamoMatch, room: CamoRoomData, now: number): void {
    const last = this.lastBroadcast.get(m.id) ?? 0;
    if (now - last < TICK_MS - 1) return;
    this.lastBroadcast.set(m.id, now);
    for (const p of this.humans(m)) this.o.sink.emit(p.userId!, 'camo.positions', { t: now, p: positionsFor(m, room, viewerOf(p), now) }, true);
  }

  /** Turns everything the rules queued into the events each client may receive. */
  afterOutbox(m: CamoMatch, now: number): void {
    if (!m.outbox.length) return;
    const events = m.outbox.splice(0);
    let phaseChanged = false;
    for (const e of events) {
      if (e.t === 'phase') phaseChanged = true;
      this.route(m, e, now);
    }
    if (phaseChanged) {
      this.broadcastRoster(m);
      if (m.phase === 'hunt') for (const p of this.humans(m)) for (const h of paintTargets(m, viewerOf(p))) this.sendPaint(p.userId!, h);
      if (m.phase === 'var' && m.rounds.length) {
        const payload = varPayload(m, m.rounds[m.rounds.length - 1]);
        for (const p of this.humans(m)) this.o.sink.emit(p.userId!, 'camo.var', payload);
      }
      // every hider's pose is part of the picture from the whistle on
      if (m.phase === 'whistle' || m.phase === 'hunt') for (const h of hidersAlive(m)) this.fanPose(m, h);
    }
  }

  private route(m: CamoMatch, e: CamoEvent, now: number): void {
    if (e.t === 'card' || e.t === 'caught' || e.t === 'whistle' || e.t === 'taunt' || e.t === 'round.end') logEvent(m, e.t, { ...e }, now);
    const send = (event: string, payload: unknown, filter?: (p: CamoPlayer) => boolean): void => {
      for (const p of this.humans(m)) if (!filter || filter(p)) this.o.sink.emit(p.userId!, event, payload);
    };
    switch (e.t) {
      case 'phase':
        break; // state is re-sent by broadcastRoster
      case 'role':
        break;
      case 'ball':
        send('camo.ball', { by: e.by, seq: e.seq, keyframes: e.keyframes.map((k) => [k.t, k.x, k.y, k.z]), events: e.events, at: e.at });
        break;
      case 'card': {
        const target = e.target ? playerById(m, e.target) : undefined;
        send('camo.card.result', {
          kind: e.kind,
          by: e.by,
          target: e.target,
          name: target?.name,
          morphId: target?.morphId,
          ricochet: !!e.ricochet,
          at: e.at,
        });
        break;
      }
      case 'caught': {
        const t = playerById(m, e.eid);
        send('camo.caught', { eid: e.eid, name: t?.name, morphId: t?.morphId, by: e.by, at: e.at });
        break;
      }
      case 'suspend':
        send('camo.suspend', { eid: e.eid, until: e.until });
        break;
      case 'whistle':
        send('camo.whistle', { by: e.by, at: e.at });
        break;
      case 'whistle.noise':
        send('camo.whistle.sound', { at: e.at, positions: e.positions.map((p) => [p.x, p.z]) });
        break;
      case 'taunt': {
        const src = playerById(m, e.eid);
        send('camo.taunt', { morphId: src?.morphId, x: e.x, z: e.z, at: e.at }, (p) => Math.hypot(p.x - e.x, p.z - e.z) <= TAUNT.range || p.eid === e.eid || p.role === 'spectator');
        break;
      }
      case 'scan': {
        const hs = e.flashed.map((id) => playerById(m, id)).filter((x): x is CamoPlayer => !!x);
        send('camo.scan', { by: e.by, flashed: hs.map((h) => [h.x, h.z]), at: e.at }, (p) => p.role === 'seeker' || p.role === 'spectator');
        break;
      }
      case 'stoppage':
        send('camo.stoppage', { endsAt: e.endsAt });
        break;
      case 'infected':
        send('camo.infected', { eid: e.eid, at: e.at });
        break;
      case 'round.end':
        send('camo.round.end', { round: e.round, winner: e.winner });
        break;
      case 'match.end':
        break;
    }
    void now;
  }
}
