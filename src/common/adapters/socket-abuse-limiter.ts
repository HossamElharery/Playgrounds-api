export interface SocketRateLimits {
  connectionAttemptsPerMinute: number;
  eventsPerSecond: number;
  eventsPerTenSeconds: number;
  maxTrackedConnectionAddresses: number;
  maxTrackedSockets: number;
}

const DEFAULT_LIMITS: SocketRateLimits = {
  connectionAttemptsPerMinute: 30,
  eventsPerSecond: 80,
  eventsPerTenSeconds: 500,
  maxTrackedConnectionAddresses: 50_000,
  maxTrackedSockets: 20_000,
};

interface WindowState {
  startedAt: number;
  count: number;
}

/**
 * A small, bounded first line of defence for the current single API instance.
 * Redis must replace this state before horizontal scaling; keeping the logic
 * isolated makes that migration explicit instead of hiding it in gateways.
 */
export class SocketAbuseLimiter {
  private readonly connections = new Map<string, WindowState>();
  private readonly events = new Map<
    string,
    { second: WindowState; tenSeconds: WindowState; lastSeenAt: number }
  >();
  private lastSweepAt = 0;

  private readonly limits: SocketRateLimits;

  constructor(limits: Partial<SocketRateLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  allowConnection(ip: string, now = Date.now()): boolean {
    this.sweep(now);
    const key = ip || 'unknown';
    if (
      !this.connections.has(key) &&
      this.connections.size >= this.limits.maxTrackedConnectionAddresses
    ) {
      return false;
    }
    return this.hit(
      this.connections,
      key,
      60_000,
      this.limits.connectionAttemptsPerMinute,
      now,
    );
  }

  allowEvent(socketId: string, now = Date.now()): boolean {
    this.sweep(now);
    const key = socketId || 'unknown';
    let state = this.events.get(key);
    if (!state) {
      if (this.events.size >= this.limits.maxTrackedSockets) return false;
      state = {
        second: { startedAt: now, count: 0 },
        tenSeconds: { startedAt: now, count: 0 },
        lastSeenAt: now,
      };
      this.events.set(key, state);
    }
    state.lastSeenAt = now;
    return (
      this.take(state.second, 1_000, this.limits.eventsPerSecond, now) &&
      this.take(state.tenSeconds, 10_000, this.limits.eventsPerTenSeconds, now)
    );
  }

  forget(socketId: string): void {
    this.events.delete(socketId);
  }

  private hit(
    store: Map<string, WindowState>,
    key: string,
    ttl: number,
    limit: number,
    now: number,
  ): boolean {
    let state = store.get(key);
    if (!state) {
      state = { startedAt: now, count: 0 };
      store.set(key, state);
    }
    return this.take(state, ttl, limit, now);
  }

  private take(
    state: WindowState,
    ttl: number,
    limit: number,
    now: number,
  ): boolean {
    if (now - state.startedAt >= ttl) {
      state.startedAt = now;
      state.count = 0;
    }
    state.count++;
    return state.count <= limit;
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < 60_000) return;
    this.lastSweepAt = now;
    for (const [key, state] of this.connections) {
      if (now - state.startedAt > 120_000) this.connections.delete(key);
    }
    for (const [key, state] of this.events) {
      if (now - state.lastSeenAt > 60_000) this.events.delete(key);
    }
  }
}
