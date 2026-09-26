import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  BALL_EVENT_GOAL,
  KEEPER_SAVE_SCALE,
  ballResting,
  createBall,
  inGoalArea,
  kickBall,
  resetBall,
  stepBall,
  type BallAabb,
  type BallPlayer,
  type BallState,
  type BallStepInfo,
} from './ball-sim';
import {
  LOBBY_MAX_CREDIT_S,
  LOBBY_MAX_SPEED,
  LOBBY_SPEED_SLACK,
  LOBBY_TELEPORT_SLACK,
  round2,
  seqAfter,
  type LobbyMove,
  type LobbyMoveMode,
} from './lobby-move.util';

/** ≤ 15 `lobby.move` per second per user (all of their sockets share it). */
export const LOBBY_MOVE_RATE = 15;
/** A member who has not moved for this long is forgotten (they respawn on the circle). */
export const LOBBY_IDLE_MS = 10 * 60 * 1000;
export const LOBBY_SWEEP_MS = 60 * 1000;

/** Distance a member may cover: refills at maxSpeed × 1.5 per second, capped at 1 s + 0.5 u. */
const TRAVEL_RATE = LOBBY_MAX_SPEED * LOBBY_SPEED_SLACK;
const TRAVEL_CAP = TRAVEL_RATE * LOBBY_MAX_CREDIT_S + LOBBY_TELEPORT_SLACK;

export interface MemberState {
  x: number;
  z: number;
  vx: number;
  vz: number;
  h: number;
  m: LobbyMoveMode;
  seq: number;
  /** Server time (ms) of the last accepted update. */
  at: number;
  /** Socket that sent `seq` (a new socket restarts its sequence). */
  socketId: string;
  /** Travel budget left (scene units), see TRAVEL_CAP. */
  budget: number;
}

export interface LobbyMoved {
  type: 'lobby.moved';
  squadId: string;
  userId: string;
  seq: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  h: number;
  m: LobbyMoveMode;
  tx?: number;
  tz?: number;
  /** Server timestamp (ms). */
  st: number;
}

export interface MoveResult {
  moved: LobbyMoved;
  /** Stops and corrections go out non-volatile; in-motion updates may be dropped. */
  reliable: boolean;
  /** Set when the position was pulled back: the sender lerps to it. */
  correction: { x: number; z: number } | null;
}

export interface LobbySnapshot {
  type: 'lobby.snapshot';
  squadId: string;
  st: number;
  members: Array<{
    userId: string;
    x: number;
    z: number;
    h: number;
    m: LobbyMoveMode;
    vx: number;
    vz: number;
  }>;
  ball?: {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    moving: boolean;
  };
  score?: BallScore;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** Server ball simulation rate while a ball moves, and its broadcast rate. */
export const BALL_TICK_HZ = 30;
export const BALL_BROADCAST_EVERY = 2; // → 15 Hz
/** After a goal the ball stays in the net this long, then respawns at the centre. */
export const GOAL_FREEZE_MS = 2500;
export const KICK_COOLDOWN_MS = 250;
/** Kick reach, measured from the server's own position of the kicker (latency slack included). */
export const KICK_MAX_DISTANCE = 1.3;
/** A walking player this close to a resting ball wakes the simulation (dribbling). */
const WAKE_DISTANCE = 1.2;
/** Server positions of moving members are extrapolated at most this far (s). */
const EXTRAPOLATE_S = 0.25;
const BODY_RADIUS = 0.38;
const KEEPER_MORPH_ID = 'keeper';
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface BallScore {
  total: number;
  byUser: Record<string, number>;
}

/** What the gateway does with ball events (it owns the Socket.IO server). */
export interface BallSink {
  /** `volatile`: may be dropped under congestion (in-motion states only). */
  toRoom(
    squadId: string,
    event: string,
    payload: object,
    volatile: boolean,
  ): void;
}

export interface KickInput {
  squadId: string;
  seq: number;
  dirX: number;
  dirZ: number;
  power: number;
}

interface BallRuntime {
  squadId: string;
  state: BallState;
  moving: boolean;
  frozenUntil: number;
  resetTimer: NodeJS.Timeout | null;
  lastTouchBy: string | null;
  score: { total: number; byUser: Map<string, number> };
  ticks: number;
  /** Last snapshot, kick or motion (idle balls of empty lobbies are swept). */
  at: number;
}

/**
 * Ephemeral lobby positions, in memory only (no database): the last accepted
 * state per (squadId, userId). The server validates every client update —
 * rate, bounds, speed and travel distance — and the gateway relays what it
 * accepted. There is no character physics here: each client simulates its
 * own avatar, everyone else interpolates the relayed states.
 */
@Injectable()
export class LobbyWorldService implements OnModuleDestroy {
  private readonly squads = new Map<string, Map<string, MemberState>>();
  private readonly buckets = new Map<string, Bucket>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly balls = new Map<string, BallRuntime>();
  private ballTimer: NodeJS.Timeout | null = null;
  private readonly kickAt = new Map<string, number>();
  private readonly morphOf = new Map<string, { id: string; at: number }>();
  private sink: BallSink | null = null;
  /** Reused every tick (no allocation per step for the players list). */
  private readonly players: BallPlayer[] = [];
  /** Extra solids (the kiosk) while that flag is on. Empty keeps the sim unchanged. */
  private ballBoxes: readonly BallAabb[] = [];
  private readonly playerIds: string[] = [];
  private readonly stepInfo: BallStepInfo = { toucher: -1 };

  /** Validated move → the state to relay, or null to drop it silently. */
  acceptMove(
    move: LobbyMove,
    userId: string,
    socketId: string,
    now: number,
  ): MoveResult | null {
    if (!this.takeToken(userId, now)) return null;
    let members = this.squads.get(move.squadId);
    const prev = members?.get(userId);
    if (prev && prev.socketId === socketId && !seqAfter(move.seq, prev.seq))
      return null;

    let x = move.x;
    let z = move.z;
    let correction: MoveResult['correction'] = null;
    let budget = TRAVEL_CAP;
    if (prev) {
      budget = Math.min(
        TRAVEL_CAP,
        prev.budget + (Math.max(0, now - prev.at) / 1000) * TRAVEL_RATE,
      );
      const dx = x - prev.x;
      const dz = z - prev.z;
      const dist = Math.hypot(dx, dz);
      if (dist > budget) {
        // Teleport: keep the clamped position (as far as it could legally get).
        const k = budget / dist;
        x = round2(prev.x + dx * k);
        z = round2(prev.z + dz * k);
        correction = { x, z };
        budget = 0;
      } else {
        budget -= dist;
      }
    }

    if (!members) {
      members = new Map();
      this.squads.set(move.squadId, members);
    }
    members.set(userId, {
      x,
      z,
      vx: move.vx,
      vz: move.vz,
      h: move.h,
      m: move.m,
      seq: move.seq,
      at: now,
      socketId,
      budget,
    });
    this.ensureSweep();
    this.maybeWakeBall(move.squadId, x, z, move.m);

    const moved: LobbyMoved = {
      type: 'lobby.moved',
      squadId: move.squadId,
      userId,
      seq: move.seq,
      x,
      z,
      vx: move.vx,
      vz: move.vz,
      h: move.h,
      m: move.m,
      st: now,
    };
    if (move.tx !== undefined && move.tz !== undefined) {
      moved.tx = move.tx;
      moved.tz = move.tz;
    }
    return { moved, reliable: move.m === 0 || correction !== null, correction };
  }

  /**
   * Everyone's last known state in one squad (members who never moved are
   * absent). With the ball on it also carries the ball and the session score
   * (and creates the squad's ball on first use).
   */
  snapshot(squadId: string, now: number, withBall = false): LobbySnapshot {
    const members: LobbySnapshot['members'] = [];
    for (const [userId, s] of this.squads.get(squadId) ?? []) {
      members.push({
        userId,
        x: s.x,
        z: s.z,
        h: s.h,
        m: s.m,
        vx: s.vx,
        vz: s.vz,
      });
    }
    const snap: LobbySnapshot = {
      type: 'lobby.snapshot',
      squadId,
      st: now,
      members,
    };
    if (withBall) {
      const ball = this.ensureBall(squadId);
      ball.at = now;
      const b = ball.state;
      snap.ball = {
        x: r2(b.x),
        y: r2(b.y),
        z: r2(b.z),
        vx: r2(b.vx),
        vy: r2(b.vy),
        vz: r2(b.vz),
        moving: ball.moving,
      };
      snap.score = scoreOf(ball);
    }
    return snap;
  }

  // ── ball (Stage 2) ─────────────────────────────────────────────────────────

  /** The gateway registers itself here so ball ticks can broadcast. */
  attachBallSink(sink: BallSink | null): void {
    this.sink = sink;
  }

  /** Solids the ball bounces off. Empty (the default) leaves the sim unchanged. */
  setBallBoxes(boxes: readonly BallAabb[]): void {
    this.ballBoxes = boxes;
  }

  /**
   * Keeper easter egg: the member's equipped morph. `force` is the gateway's
   * first read for a lobby member; MorphsService.equipped$ only updates users
   * already known, so equips outside any lobby never grow the map.
   */
  setMorph(userId: string, morphId: string, force = false): void {
    if (!force && !this.morphOf.has(userId)) return;
    this.morphOf.set(userId, { id: morphId, at: Date.now() });
    this.ensureSweep();
  }

  hasMorph(userId: string): boolean {
    return this.morphOf.has(userId);
  }

  hasBall(squadId: string): boolean {
    return this.balls.has(squadId);
  }

  /** Balls the shared interval is simulating right now (resting ones cost nothing). */
  get activeBallCount(): number {
    let n = 0;
    for (const ball of this.balls.values()) if (ball.moving) n++;
    return n;
  }

  /** Is the shared simulation interval running (only while some ball moves)? */
  get ballTicking(): boolean {
    return this.ballTimer !== null;
  }

  ballState(squadId: string): BallState | null {
    return this.balls.get(squadId)?.state ?? null;
  }

  score(squadId: string): BallScore | null {
    const ball = this.balls.get(squadId);
    return ball ? scoreOf(ball) : null;
  }

  /**
   * A validated kick: cooldown (250 ms per user), not during the goal freeze,
   * and within 1.3 u of the ball measured from the server's own position of
   * the kicker. Applies the impulse, marks the toucher, and broadcasts at once
   * (non-volatile). Returns false when refused (silently).
   */
  kick(k: KickInput, userId: string, now: number): boolean {
    const ball = this.balls.get(k.squadId);
    if (!ball || now < ball.frozenUntil || ball.resetTimer) return false;
    const last = this.kickAt.get(userId);
    if (last !== undefined && now - last < KICK_COOLDOWN_MS) return false;
    const me = this.squads.get(k.squadId)?.get(userId);
    if (!me) return false;
    const lead =
      me.m === 0 ? 0 : Math.min(EXTRAPOLATE_S, Math.max(0, now - me.at) / 1000);
    const px = me.x + me.vx * lead;
    const pz = me.z + me.vz * lead;
    const b = ball.state;
    if (Math.hypot(b.x - px, b.z - pz) > KICK_MAX_DISTANCE) return false;
    if (!kickBall(b, k.dirX, k.dirZ, k.power)) return false;
    this.kickAt.set(userId, now);
    ball.at = now;
    ball.lastTouchBy = userId;
    ball.moving = true;
    this.broadcastBall(ball, now, false, userId, k.seq);
    this.ensureBallTimer();
    return true;
  }

  /** One simulation tick for every moving ball (the shared 30 Hz interval). */
  tickBalls(now: number): void {
    const dt = 1 / BALL_TICK_HZ;
    let active = false;
    for (const ball of this.balls.values()) {
      if (!ball.moving || now < ball.frozenUntil || ball.resetTimer) continue;
      const n = this.collectPlayers(ball.squadId, now);
      const events = stepBall(
        ball.state,
        this.players,
        n,
        dt,
        this.stepInfo,
        this.ballBoxes,
      );
      if (this.stepInfo.toucher >= 0)
        ball.lastTouchBy = this.playerIds[this.stepInfo.toucher];
      if (events & BALL_EVENT_GOAL) {
        this.goal(ball, now);
        continue;
      }
      ball.ticks++;
      ball.at = now;
      if (ballResting(ball.state)) {
        ball.moving = false;
        this.broadcastBall(ball, now, false);
      } else {
        active = true;
        if (ball.ticks % BALL_BROADCAST_EVERY === 0)
          this.broadcastBall(ball, now, true);
      }
    }
    // Every ball at rest (or frozen in the net): no timer runs at all.
    if (!active) this.stopBallTimer();
  }

  private ensureBall(squadId: string): BallRuntime {
    let ball = this.balls.get(squadId);
    if (!ball) {
      ball = {
        squadId,
        state: createBall(),
        moving: false,
        frozenUntil: 0,
        resetTimer: null,
        lastTouchBy: null,
        score: { total: 0, byUser: new Map() },
        ticks: 0,
        at: Date.now(),
      };
      this.balls.set(squadId, ball);
      this.ensureSweep();
    }
    return ball;
  }

  private maybeWakeBall(
    squadId: string,
    x: number,
    z: number,
    m: LobbyMoveMode,
  ): void {
    const ball = this.balls.get(squadId);
    if (!ball || ball.moving || ball.resetTimer || m === 0) return;
    const b = ball.state;
    if (Math.hypot(b.x - x, b.z - z) > WAKE_DISTANCE) return;
    ball.moving = true;
    this.ensureBallTimer();
  }

  /** Members as circles for the ball (moving ones extrapolated ≤ 250 ms; the keeper's save radius). */
  private collectPlayers(squadId: string, now: number): number {
    let n = 0;
    for (const [userId, s] of this.squads.get(squadId) ?? []) {
      const lead =
        s.m === 0 ? 0 : Math.min(EXTRAPOLATE_S, Math.max(0, now - s.at) / 1000);
      const x = s.x + s.vx * lead;
      const z = s.z + s.vz * lead;
      const keeper =
        this.morphOf.get(userId)?.id === KEEPER_MORPH_ID && inGoalArea(x, z);
      let p = this.players[n];
      if (!p) {
        p = { x: 0, z: 0, vx: 0, vz: 0, r: BODY_RADIUS };
        this.players[n] = p;
      }
      p.x = x;
      p.z = z;
      p.vx = s.m === 0 ? 0 : s.vx;
      p.vz = s.m === 0 ? 0 : s.vz;
      p.r = keeper ? BODY_RADIUS * KEEPER_SAVE_SCALE : BODY_RADIUS;
      this.playerIds[n] = userId;
      n++;
    }
    return n;
  }

  private goal(ball: BallRuntime, now: number): void {
    const scorerId = ball.lastTouchBy;
    ball.score.total++;
    if (scorerId)
      ball.score.byUser.set(
        scorerId,
        (ball.score.byUser.get(scorerId) ?? 0) + 1,
      );
    ball.frozenUntil = now + GOAL_FREEZE_MS;
    ball.moving = false;
    const b = ball.state;
    b.vx = b.vy = b.vz = 0;
    const score = scoreOf(ball);
    this.sink?.toRoom(
      ball.squadId,
      'lobby.ball.goal',
      {
        type: 'lobby.ball.goal',
        squadId: ball.squadId,
        scorerId,
        total: score.total,
        byUser: score.byUser,
      },
      false,
    );
    ball.resetTimer = setTimeout(
      () => this.resetAfterGoal(ball.squadId),
      GOAL_FREEZE_MS,
    );
    ball.resetTimer.unref?.();
  }

  private resetAfterGoal(squadId: string): void {
    const ball = this.balls.get(squadId);
    if (!ball) return;
    ball.resetTimer = null;
    ball.frozenUntil = 0;
    ball.lastTouchBy = null;
    resetBall(ball.state);
    ball.moving = true; // the drop-bounce
    const now = Date.now();
    const b = ball.state;
    this.sink?.toRoom(
      squadId,
      'lobby.ball.reset',
      {
        type: 'lobby.ball.reset',
        squadId,
        st: now,
        b: [r2(b.x), r2(b.y), r2(b.z), r2(b.vx), r2(b.vy), r2(b.vz)],
      },
      false,
    );
    this.ensureBallTimer();
  }

  /**
   * `lobby.ball.state`, compact (≤ 100 B in motion): sq = squad tag, b = [x, y,
   * z, vx, vy, vz], m = moving. A kick adds k (kicker) and s (their seq).
   */
  private broadcastBall(
    ball: BallRuntime,
    now: number,
    volatile: boolean,
    kicker?: string,
    seq?: number,
  ): void {
    const b = ball.state;
    const payload: Record<string, unknown> = {
      sq: ball.squadId.slice(0, 8),
      st: now,
      b: [r2(b.x), r2(b.y), r2(b.z), r2(b.vx), r2(b.vy), r2(b.vz)],
      m: ball.moving ? 1 : 0,
    };
    if (kicker) {
      payload['k'] = kicker;
      payload['s'] = seq;
    }
    this.sink?.toRoom(ball.squadId, 'lobby.ball.state', payload, volatile);
  }

  private ensureBallTimer(): void {
    if (this.ballTimer) return;
    this.ballTimer = setInterval(
      () => this.tickBalls(Date.now()),
      1000 / BALL_TICK_HZ,
    );
    this.ballTimer.unref?.();
  }

  private stopBallTimer(): void {
    if (this.ballTimer) clearInterval(this.ballTimer);
    this.ballTimer = null;
  }

  private dropBall(squadId: string): void {
    const ball = this.balls.get(squadId);
    if (!ball) return;
    if (ball.resetTimer) clearTimeout(ball.resetTimer);
    this.balls.delete(squadId);
    if (![...this.balls.values()].some((b) => b.moving)) this.stopBallTimer();
  }

  /** Left, kicked or dropped past the grace period. */
  memberLeft(squadId: string, userId: string): void {
    this.morphOf.delete(userId);
    this.kickAt.delete(userId);
    const members = this.squads.get(squadId);
    if (!members) return;
    members.delete(userId);
    if (!members.size) this.squadEmptied(squadId);
  }

  /** The squad emptied or was deleted: positions, ball and score go with it. */
  squadEmptied(squadId: string): void {
    this.squads.delete(squadId);
    this.dropBall(squadId);
    this.maybeStopSweep();
  }

  /** Forget members idle past LOBBY_IDLE_MS and stale rate buckets. */
  sweep(now: number): void {
    for (const [squadId, members] of this.squads) {
      for (const [userId, s] of members) {
        if (now - s.at > LOBBY_IDLE_MS) members.delete(userId);
      }
      if (!members.size) this.squads.delete(squadId);
    }
    for (const [userId, b] of this.buckets) {
      if (now - b.at > LOBBY_SWEEP_MS) this.buckets.delete(userId);
    }
    for (const [userId, at] of this.kickAt) {
      if (now - at > LOBBY_SWEEP_MS) this.kickAt.delete(userId);
    }
    // A ball at rest in a lobby nobody walks in any more; morphs of users
    // who are no longer anywhere in a lobby.
    for (const [squadId, ball] of this.balls) {
      if (ball.moving || ball.resetTimer || this.squads.has(squadId)) continue;
      if (now - ball.at > LOBBY_IDLE_MS) this.balls.delete(squadId);
    }
    for (const [userId, m] of this.morphOf) {
      if (now - m.at > LOBBY_IDLE_MS && !this.present(userId))
        this.morphOf.delete(userId);
    }
    this.maybeStopSweep();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.stopBallTimer();
    for (const ball of this.balls.values())
      if (ball.resetTimer) clearTimeout(ball.resetTimer);
  }

  /** Token bucket: LOBBY_MOVE_RATE tokens, refilled continuously. */
  private takeToken(userId: string, now: number): boolean {
    const b = this.buckets.get(userId);
    if (!b) {
      this.buckets.set(userId, { tokens: LOBBY_MOVE_RATE - 1, at: now });
      this.ensureSweep();
      return true;
    }
    b.tokens = Math.min(
      LOBBY_MOVE_RATE,
      b.tokens + (Math.max(0, now - b.at) / 1000) * LOBBY_MOVE_RATE,
    );
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(Date.now()), LOBBY_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  private present(userId: string): boolean {
    for (const members of this.squads.values())
      if (members.has(userId)) return true;
    return false;
  }

  private maybeStopSweep(): void {
    if (this.squads.size || this.buckets.size || this.kickAt.size) return;
    if (this.balls.size || this.morphOf.size) return;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

function scoreOf(ball: BallRuntime): BallScore {
  const byUser: Record<string, number> = {};
  for (const [id, n] of ball.score.byUser) byUser[id] = n;
  return { total: ball.score.total, byUser };
}
