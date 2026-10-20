import type { GameHostDeps } from './dakhla-host';
import {
  beginKickoff,
  beginPlay,
  cancelThief,
  createThief,
  dodge,
  finishThief,
  joinThief,
  leaveThief,
  tackle,
  thiefStep,
  thiefView,
  tickThief,
  type TackleOutcome,
  type ThiefPos,
  type ThiefState,
  type ThiefView,
} from './thief-rules';

export const THIEF_TICK_MS = 100;
/** Scores change every tick; the room hears about it at most this often (events go out at once). */
const SCORE_EVERY_MS = 500;

export interface ThiefHostDeps extends GameHostDeps {
  /** Where the server last saw a player, nudged forward by their velocity. */
  pos(squadId: string, userId: string, now: number): ThiefPos | null;
  /** The game owns the ball (true) or hands it back to free play at this spot (false). */
  ballHeld(squadId: string, held: boolean, at: ThiefPos): void;
}

/** Runs every squad's «حرامي الكورة». */
export class ThiefHost {
  private readonly games = new Map<string, ThiefState>();
  private readonly flushedSeq = new Map<string, number>();
  private readonly flushedAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ThiefHostDeps) {}

  get(squadId: string): ThiefState | null {
    return this.games.get(squadId) ?? null;
  }

  /** The game holds the pitch (and the ball) from the gathering to the final whistle. */
  active(squadId: string): boolean {
    const s = this.games.get(squadId);
    return !!s && s.phase !== 'ended';
  }

  /** Kicks are off while the ball is being carried. */
  ownsBall(squadId: string): boolean {
    const s = this.games.get(squadId);
    return !!s && (s.phase === 'kickoff' || s.phase === 'playing');
  }

  view(squadId: string, now: number): ThiefView | null {
    const s = this.games.get(squadId);
    return s ? thiefView(s, now) : null;
  }

  start(squadId: string, userId: string, now: number): ThiefView | null {
    const present = this.deps.members(squadId);
    if (!present.includes(userId)) return null;
    const old = this.games.get(squadId);
    if (old && old.phase !== 'ended') return null;
    if (this.deps.busy(squadId)) return null;
    const s = createThief(squadId, userId, now, (old?.round ?? 0) + 1);
    this.games.set(squadId, s);
    this.flush(s, now);
    this.ensureTimer();
    return thiefView(s, now);
  }

  join(squadId: string, userId: string, now: number): boolean {
    const s = this.games.get(squadId);
    if (
      !s ||
      !this.deps.members(squadId).includes(userId) ||
      !joinThief(s, userId)
    )
      return false;
    this.flush(s, now);
    return true;
  }

  go(squadId: string, userId: string, now: number): boolean {
    const s = this.games.get(squadId);
    if (!s || s.phase !== 'gathering' || s.starterId !== userId) return false;
    this.kickoff(s, now);
    this.flush(s, now);
    return true;
  }

  leave(squadId: string, userId: string, now: number): boolean {
    const s = this.games.get(squadId);
    if (!s || s.phase === 'ended') return false;
    leaveThief(s, userId, (id) => this.deps.pos(squadId, id, now), now);
    this.afterChange(s, now);
    return true;
  }

  cancel(squadId: string, userId: string, now: number): boolean {
    const s = this.games.get(squadId);
    if (!s || s.phase === 'ended' || s.starterId !== userId) return false;
    cancelThief(s, now);
    this.afterChange(s, now);
    return true;
  }

  tackle(squadId: string, userId: string, now: number): TackleOutcome {
    const s = this.games.get(squadId);
    if (!s) return 'invalid';
    const out = tackle(s, userId, (id) => this.deps.pos(squadId, id, now), now);
    if (out !== 'invalid') this.flush(s, now);
    return out;
  }

  dodge(squadId: string, userId: string, now: number): boolean {
    const s = this.games.get(squadId);
    if (!s || !dodge(s, userId, now)) return false;
    this.flush(s, now);
    return true;
  }

  memberLeft(squadId: string, userId: string, now: number): void {
    const s = this.games.get(squadId);
    if (!s || s.phase === 'ended') return;
    leaveThief(s, userId, (id) => this.deps.pos(squadId, id, now), now);
    this.afterChange(s, now);
  }

  drop(squadId: string): void {
    this.games.delete(squadId);
    this.flushedSeq.delete(squadId);
    this.flushedAt.delete(squadId);
    if (!this.games.size) this.stopTimer();
  }

  tick(now: number): void {
    for (const [squadId, s] of this.games) {
      const step = thiefStep(s, now);
      switch (step) {
        case 'kickoff':
          this.kickoff(s, now);
          break;
        case 'play':
          beginPlay(s, now);
          break;
        case 'finish':
          tickThief(s, (id) => this.deps.pos(squadId, id, now), now);
          finishThief(s, now);
          this.release(s);
          break;
        case 'drop':
          this.drop(squadId);
          continue;
        default:
          tickThief(s, (id) => this.deps.pos(squadId, id, now), now);
      }
      const news = step !== 'none' || s.seq !== this.flushedSeq.get(squadId);
      if (
        news ||
        (s.dirty && now - (this.flushedAt.get(squadId) ?? 0) >= SCORE_EVERY_MS)
      )
        this.flush(s, now);
    }
    if (!this.games.size) this.stopTimer();
  }

  dispose(): void {
    this.stopTimer();
    this.games.clear();
  }

  private kickoff(s: ThiefState, now: number): void {
    if (beginKickoff(s, now)) this.deps.ballHeld(s.squadId, true, s.ball);
  }

  private afterChange(s: ThiefState, now: number): void {
    if (s.phase === 'ended') this.release(s);
    this.flush(s, now);
  }

  private release(s: ThiefState): void {
    this.deps.ballHeld(s.squadId, false, s.ball);
  }

  private flush(s: ThiefState, now: number): void {
    s.dirty = false;
    this.flushedSeq.set(s.squadId, s.seq);
    this.flushedAt.set(s.squadId, now);
    this.deps.emit(s.squadId, 'lobby.thief.state', thiefView(s, now));
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(Date.now()), THIEF_TICK_MS);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
