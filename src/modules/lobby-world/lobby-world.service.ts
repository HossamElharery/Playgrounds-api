import { Injectable, OnModuleDestroy } from '@nestjs/common';
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
}

interface Bucket {
  tokens: number;
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

  /** Everyone's last known state in one squad (members who never moved are absent). */
  snapshot(squadId: string, now: number): LobbySnapshot {
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
    return { type: 'lobby.snapshot', squadId, st: now, members };
  }

  /** Left, kicked or dropped past the grace period. */
  memberLeft(squadId: string, userId: string): void {
    const members = this.squads.get(squadId);
    if (!members) return;
    members.delete(userId);
    if (!members.size) this.squadEmptied(squadId);
  }

  /** The squad emptied or was deleted. */
  squadEmptied(squadId: string): void {
    this.squads.delete(squadId);
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
    this.maybeStopSweep();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
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

  private maybeStopSweep(): void {
    if (!this.squads.size && !this.buckets.size) this.onModuleDestroy();
  }
}
