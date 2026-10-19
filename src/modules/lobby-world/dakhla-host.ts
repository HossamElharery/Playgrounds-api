import {
  beginSong,
  cancelDakhla,
  createDakhla,
  dakhlaStep,
  dakhlaView,
  finishDakhla,
  joinDakhla,
  leaveDakhla,
  reportDakhla,
  type DakhlaChantId,
  type DakhlaLevel,
  type DakhlaReport,
  type DakhlaState,
  type DakhlaView,
} from './dakhla-rules';

export const DAKHLA_TICK_MS = 250;

export interface GameHostDeps {
  /** Users present in the squad's lobby right now. */
  members(squadId: string): readonly string[];
  emit(squadId: string, event: string, payload: object): void;
  /** Another lobby game owns the pitch right now. */
  busy(squadId: string): boolean;
}

/** Runs every squad's «الدخلة»: timers, joins and the throttled score broadcast. */
export class DakhlaHost {
  private readonly games = new Map<string, DakhlaState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: GameHostDeps) {}

  get(squadId: string): DakhlaState | null {
    return this.games.get(squadId) ?? null;
  }

  /** A song is gathering or playing (the result screen does not hold the pitch). */
  active(squadId: string): boolean {
    const s = this.games.get(squadId);
    return !!s && s.phase !== 'ended';
  }

  view(squadId: string, now: number): DakhlaView | null {
    const s = this.games.get(squadId);
    return s ? dakhlaView(s, now) : null;
  }

  start(
    squadId: string,
    userId: string,
    chant: DakhlaChantId,
    level: DakhlaLevel,
    now: number,
  ): DakhlaView | null {
    const present = this.deps.members(squadId);
    if (!present.includes(userId)) return null;
    const old = this.games.get(squadId);
    if (old && old.phase !== 'ended') return null;
    if (this.deps.busy(squadId)) return null;
    const s = createDakhla(
      squadId,
      userId,
      chant,
      level,
      present.length <= 1,
      now,
      (old?.round ?? 0) + 1,
    );
    this.games.set(squadId, s);
    this.flush(s, now);
    this.ensureTimer();
    return dakhlaView(s, now);
  }

  join(
    squadId: string,
    userId: string,
    level: DakhlaLevel,
    now: number,
  ): boolean {
    const s = this.games.get(squadId);
    if (
      !s ||
      !this.deps.members(squadId).includes(userId) ||
      !joinDakhla(s, userId, level, now)
    )
      return false;
    this.flush(s, now);
    return true;
  }

  /** Everybody who said yes is in: no need to wait out the gathering timer. */
  go(squadId: string, userId: string, now: number): boolean {
    const s = this.games.get(squadId);
    if (!s || s.phase !== 'gathering' || s.capoId !== userId) return false;
    beginSong(s, now);
    this.flush(s, now);
    return true;
  }

  leave(squadId: string, userId: string, now: number): boolean {
    const s = this.games.get(squadId);
    if (!s || s.phase === 'ended') return false;
    leaveDakhla(s, userId, now);
    this.flush(s, now);
    return true;
  }

  cancel(squadId: string, userId: string, now: number): boolean {
    const s = this.games.get(squadId);
    if (!s || s.phase === 'ended' || s.capoId !== userId) return false;
    cancelDakhla(s, now);
    this.flush(s, now);
    return true;
  }

  report(
    squadId: string,
    userId: string,
    r: DakhlaReport,
    now: number,
  ): boolean {
    const s = this.games.get(squadId);
    // Broadcast on the next tick: many players reporting together cost one message.
    return !!s && reportDakhla(s, userId, r, now);
  }

  memberLeft(squadId: string, userId: string, now: number): void {
    const s = this.games.get(squadId);
    if (!s) return;
    if (s.phase === 'ended') return;
    leaveDakhla(s, userId, now);
    this.flush(s, now);
  }

  drop(squadId: string): void {
    this.games.delete(squadId);
    if (!this.games.size) this.stopTimer();
  }

  tick(now: number): void {
    for (const [squadId, s] of this.games) {
      switch (dakhlaStep(s, now)) {
        case 'begin':
          beginSong(s, now);
          break;
        case 'finish':
          finishDakhla(s, now);
          break;
        case 'drop':
          this.games.delete(squadId);
          continue;
      }
      if (s.dirty) this.flush(s, now);
    }
    if (!this.games.size) this.stopTimer();
  }

  dispose(): void {
    this.stopTimer();
    this.games.clear();
  }

  private flush(s: DakhlaState, now: number): void {
    s.dirty = false;
    this.deps.emit(s.squadId, 'lobby.dak.state', dakhlaView(s, now));
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(Date.now()), DAKHLA_TICK_MS);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
