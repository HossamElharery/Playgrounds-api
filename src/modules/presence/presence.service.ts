import { Injectable } from '@nestjs/common';

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

  markConnected(userId: string, socketId: string): void {
    if (!this.online.has(userId)) this.online.set(userId, new Set());
    this.online.get(userId)!.add(socketId);
  }

  markDisconnected(userId: string, socketId: string): void {
    this.online.get(userId)?.delete(socketId);
    if (this.online.get(userId)?.size === 0) this.online.delete(userId);
  }

  setInSquad(userId: string, inSquad: boolean): void {
    if (inSquad) this.inSquad.add(userId);
    else this.inSquad.delete(userId);
  }

  isOnline(userId: string, lastSeenAt?: Date | string | null): boolean {
    return this.online.has(userId) || this.isFresh(lastSeenAt);
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
