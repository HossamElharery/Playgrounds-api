import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

export type PresenceState = 'online' | 'offline' | 'in_squad';

/** A friend is online if a socket is live, or they heartbeated within this window. */
export const PRESENCE_ONLINE_WINDOW_MS = 90_000;

/**
 * In-memory presence tracker (single-instance deployment — see
 * MATCHENA_BACKEND.md for the Redis-adapter upgrade path for multi-instance).
 * The realtime gateway updates this on socket connect/disconnect; the
 * social/friends module reads it for the `presence` field in DirectThreadSummary
 * and the friends list (§16.5).
 *
 * Production also treats a fresh `lastSeenAt` as online so the friends list
 * stays correct when Socket.IO is proxied across a separate API host, or
 * when a replica other than the socket owner answers GET /friends.
 */
@Injectable()
export class PresenceService {
  private online = new Map<string, Set<string>>(); // userId -> socketIds
  private inSquad = new Set<string>();
  /** Squad members whose socket is gone but whose grace period has not run
   * out yet — the lobby shows them as reconnecting rather than dropping them. */
  private squadDisconnected = new Set<string>();

  /**
   * Fires when a user's *first* socket arrives or their *last* one goes away.
   * Feature modules (squad lobbies) subscribe instead of the gateway reaching
   * into them — the gateway stays transport-only and the module graph stays
   * acyclic.
   */
  private readonly connectionChanges = new Subject<{
    userId: string;
    connected: boolean;
  }>();
  readonly connection$: Observable<{ userId: string; connected: boolean }> =
    this.connectionChanges.asObservable();

  markConnected(userId: string, socketId: string): void {
    const first = !this.online.has(userId);
    if (first) this.online.set(userId, new Set());
    this.online.get(userId)!.add(socketId);
    if (first) this.connectionChanges.next({ userId, connected: true });
  }

  markDisconnected(userId: string, socketId: string): void {
    const sockets = this.online.get(userId);
    if (!sockets?.delete(socketId)) return;
    if (sockets.size > 0) return;
    this.online.delete(userId);
    this.connectionChanges.next({ userId, connected: false });
  }

  setInSquad(userId: string, inSquad: boolean): void {
    if (inSquad) this.inSquad.add(userId);
    else {
      this.inSquad.delete(userId);
      this.squadDisconnected.delete(userId);
    }
  }

  setSquadConnected(userId: string, connected: boolean): void {
    if (connected) this.squadDisconnected.delete(userId);
    else this.squadDisconnected.add(userId);
  }

  isSquadConnected(userId: string): boolean {
    return !this.squadDisconnected.has(userId);
  }

  /** Last time we saw *any* authenticated activity from this user, socket or
   * not. Lets an open tab whose websocket is flapping keep its lobby seat. */
  private readonly lastActivity = new Map<string, number>();

  /** Returns true when the caller should also persist `lastSeenAt` — throttled
   * so a 12s poll does not mean a database write every 12s. */
  touch(userId: string, throttleMs = 20_000): boolean {
    const now = Date.now();
    const previous = this.lastActivity.get(userId) ?? 0;
    this.lastActivity.set(userId, now);
    return now - previous > throttleMs;
  }

  private isActive(userId: string, windowMs = PRESENCE_ONLINE_WINDOW_MS): boolean {
    const seen = this.lastActivity.get(userId);
    return seen !== undefined && Date.now() - seen < windowMs;
  }

  /**
   * Stricter than `isOnline`: is this user reachable *right now* — a live
   * socket, or an app that called us within `windowMs`. Lobby eviction uses
   * this so a closed tab goes quickly while an open one with a flapping
   * websocket keeps its seat.
   */
  isReachable(userId: string, windowMs: number): boolean {
    return this.online.has(userId) || this.isActive(userId, windowMs);
  }

  isOnline(userId: string, lastSeenAt?: Date | string | null): boolean {
    return this.online.has(userId) || this.isActive(userId) || this.isFresh(lastSeenAt);
  }

  stateFor(userId: string, lastSeenAt?: Date | string | null): PresenceState {
    if (this.inSquad.has(userId)) return 'in_squad';
    return this.isOnline(userId, lastSeenAt) ? 'online' : 'offline';
  }

  private isFresh(lastSeenAt?: Date | string | null): boolean {
    if (!lastSeenAt) return false;
    const t =
      lastSeenAt instanceof Date ? lastSeenAt.getTime() : Date.parse(String(lastSeenAt));
    return Number.isFinite(t) && Date.now() - t < PRESENCE_ONLINE_WINDOW_MS;
  }
}
