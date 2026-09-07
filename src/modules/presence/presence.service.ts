import { Injectable } from '@nestjs/common';

export type PresenceState = 'online' | 'offline' | 'in_squad';

/**
 * In-memory presence tracker (single-instance deployment — see
 * MAL3AB_BACKEND.md for the Redis-adapter upgrade path for multi-instance).
 * The realtime gateway updates this on socket connect/disconnect; the
 * social/friends module reads it for the `presence` field in DirectThreadSummary
 * and the friends list (§16.5).
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

  isOnline(userId: string): boolean {
    return this.online.has(userId);
  }

  stateFor(userId: string): PresenceState {
    if (this.inSquad.has(userId)) return 'in_squad';
    return this.isOnline(userId) ? 'online' : 'offline';
  }
}
