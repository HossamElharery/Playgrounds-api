import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

export type PresenceState = 'online' | 'offline' | 'in_squad';

export const PRESENCE_ONLINE_WINDOW_MS = 90_000;

@Injectable()
export class PresenceService {
  private online = new Map<string, Set<string>>(); // userId -> socketIds
  private inSquad = new Set<string>();
  private squadDisconnected = new Set<string>();

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

  private readonly lastActivity = new Map<string, number>();

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
