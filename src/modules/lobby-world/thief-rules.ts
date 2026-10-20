/**
 * «حرامي الكورة»: keep-away on the lobby pitch. Whoever has the ball banks time; everybody else tries to steal it.
 * The server owns possession, tackles, dodges and the clock; positions come from the lobby's validated moves.
 */

export const THIEF_GATHER_MS = 10000;
export const THIEF_KICKOFF_MS = 3500;
export const THIEF_PLAY_MS = 120000;
/** The last stretch counts double. */
export const THIEF_GOLDEN_MS = 20000;
export const THIEF_RESULT_MS = 14000;
export const THIEF_MIN_PLAYERS = 2;
export const THIEF_MAX_PLAYERS = 8;

/** A loose ball is picked up by the first player this close. */
export const GRAB_RADIUS = 0.85;
/** A tackle reaches this far (the server's positions are a little old, so it is generous). */
export const TACKLE_REACH = 1.55;
export const TACKLE_COOLDOWN_MS = 1200;
export const MISS_COOLDOWN_MS = 1800;
/** Fresh thieves cannot be robbed straight back. */
export const STEAL_IMMUNITY_MS = 1300;
/** The one who lost the ball needs a moment before tackling. */
export const VICTIM_STUN_MS = 900;
export const DODGE_MS = 550;
export const DODGE_COOLDOWN_MS = 3800;
export const KICKOFF_SPOT = { x: 0, z: -0.6 } as const;

export type ThiefPhase = 'gathering' | 'kickoff' | 'playing' | 'ended';
export type ThiefEventKind =
  | 'grab'
  | 'steal'
  | 'miss'
  | 'dodged'
  | 'dodge'
  | 'golden'
  | 'drop';

export interface ThiefEvent {
  kind: ThiefEventKind;
  by: string | null;
  from: string | null;
  at: number;
  seq: number;
}

export interface ThiefPos {
  x: number;
  z: number;
}

export interface ThiefResult {
  winners: string[];
  topStealer: string | null;
  longestId: string | null;
  longestMs: number;
}

export interface ThiefState {
  squadId: string;
  round: number;
  starterId: string;
  phase: ThiefPhase;
  phaseUntil: number;
  playUntil: number;
  players: string[];
  holderId: string | null;
  holdSince: number;
  ball: ThiefPos;
  heldMs: Record<string, number>;
  steals: Record<string, number>;
  longestMs: Record<string, number>;
  immuneUntil: number;
  cooldownUntil: Record<string, number>;
  dodgeUntil: number;
  dodgeReadyAt: Record<string, number>;
  lastTickAt: number;
  event: ThiefEvent | null;
  seq: number;
  result: ThiefResult | null;
  cancelled: boolean;
  rev: number;
  dirty: boolean;
}

export function createThief(
  squadId: string,
  starterId: string,
  now: number,
  round = 1,
): ThiefState {
  return {
    squadId,
    round,
    starterId,
    phase: 'gathering',
    phaseUntil: now + THIEF_GATHER_MS,
    playUntil: 0,
    players: [starterId],
    holderId: null,
    holdSince: 0,
    ball: { ...KICKOFF_SPOT },
    heldMs: { [starterId]: 0 },
    steals: { [starterId]: 0 },
    longestMs: { [starterId]: 0 },
    immuneUntil: 0,
    cooldownUntil: {},
    dodgeUntil: 0,
    dodgeReadyAt: {},
    lastTickAt: now,
    event: null,
    seq: 0,
    result: null,
    cancelled: false,
    rev: 1,
    dirty: true,
  };
}

export function joinThief(s: ThiefState, userId: string): boolean {
  if (s.players.includes(userId)) return true;
  // Joining mid-game is fine: you start on zero and chase.
  if (s.phase === 'ended' || s.players.length >= THIEF_MAX_PLAYERS)
    return false;
  s.players.push(userId);
  s.heldMs[userId] = 0;
  s.steals[userId] = 0;
  s.longestMs[userId] = 0;
  touch(s);
  return true;
}

export function beginKickoff(s: ThiefState, now: number): boolean {
  if (s.players.length < THIEF_MIN_PLAYERS) {
    cancelThief(s, now);
    return false;
  }
  s.phase = 'kickoff';
  s.phaseUntil = now + THIEF_KICKOFF_MS;
  s.ball = { ...KICKOFF_SPOT };
  s.holderId = null;
  touch(s);
  return true;
}

export function beginPlay(s: ThiefState, now: number): void {
  s.phase = 'playing';
  s.playUntil = now + THIEF_PLAY_MS;
  s.phaseUntil = s.playUntil;
  s.lastTickAt = now;
  touch(s);
}

export function golden(s: ThiefState, now: number): boolean {
  return s.phase === 'playing' && now >= s.playUntil - THIEF_GOLDEN_MS;
}

/**
 * One step of play: the holder banks time (double in the golden stretch), a loose ball goes to the nearest player
 * in reach, and the ball sits at the holder's feet. `pos` returns where the server last saw a player.
 */
export function tickThief(
  s: ThiefState,
  pos: (userId: string) => ThiefPos | null,
  now: number,
): void {
  if (s.phase !== 'playing') return;
  const wasGolden = s.lastTickAt >= s.playUntil - THIEF_GOLDEN_MS;
  const until = Math.min(now, s.playUntil);
  const dt = Math.max(0, until - s.lastTickAt);
  if (s.holderId && dt > 0) {
    // Split the step at the golden line so the double rate starts exactly on time.
    const line = s.playUntil - THIEF_GOLDEN_MS;
    const before = Math.max(0, Math.min(until, line) - s.lastTickAt);
    const after = dt - before;
    s.heldMs[s.holderId] = (s.heldMs[s.holderId] ?? 0) + before + after * 2;
    s.longestMs[s.holderId] = Math.max(
      s.longestMs[s.holderId] ?? 0,
      until - s.holdSince,
    );
    s.dirty = true;
  }
  s.lastTickAt = until;
  if (!wasGolden && golden(s, until)) emit(s, 'golden', null, null, until);
  if (s.holderId) {
    const p = pos(s.holderId);
    if (p) s.ball = { x: p.x, z: p.z };
    return;
  }
  let best: string | null = null;
  let bestD = GRAB_RADIUS;
  for (const id of s.players) {
    const p = pos(id);
    if (!p) continue;
    const d = Math.hypot(p.x - s.ball.x, p.z - s.ball.z);
    if (d <= bestD) {
      best = id;
      bestD = d;
    }
  }
  if (best) take(s, best, 'grab', null, now);
}

export type TackleOutcome = 'steal' | 'miss' | 'dodged' | 'invalid';

export function tackle(
  s: ThiefState,
  by: string,
  pos: (userId: string) => ThiefPos | null,
  now: number,
): TackleOutcome {
  if (
    s.phase !== 'playing' ||
    !s.holderId ||
    by === s.holderId ||
    !s.players.includes(by)
  )
    return 'invalid';
  if (now < (s.cooldownUntil[by] ?? 0)) return 'invalid';
  const me = pos(by);
  const them = pos(s.holderId);
  if (!me || !them) return 'invalid';
  const inReach = Math.hypot(me.x - them.x, me.z - them.z) <= TACKLE_REACH;
  if (inReach && now < s.dodgeUntil) {
    s.cooldownUntil[by] = now + MISS_COOLDOWN_MS;
    emit(s, 'dodged', s.holderId, by, now);
    return 'dodged';
  }
  if (!inReach || now < s.immuneUntil) {
    s.cooldownUntil[by] = now + MISS_COOLDOWN_MS;
    emit(s, 'miss', by, s.holderId, now);
    return 'miss';
  }
  const victim = s.holderId;
  take(s, by, 'steal', victim, now);
  s.steals[by] = (s.steals[by] ?? 0) + 1;
  s.cooldownUntil[by] = now + TACKLE_COOLDOWN_MS;
  s.cooldownUntil[victim] = now + VICTIM_STUN_MS;
  return 'steal';
}

export function dodge(s: ThiefState, by: string, now: number): boolean {
  if (
    s.phase !== 'playing' ||
    s.holderId !== by ||
    now < (s.dodgeReadyAt[by] ?? 0)
  )
    return false;
  s.dodgeUntil = now + DODGE_MS;
  s.dodgeReadyAt[by] = now + DODGE_COOLDOWN_MS;
  emit(s, 'dodge', by, null, now);
  return true;
}

/** Returns false when too few players are left and the game was cancelled. */
export function leaveThief(
  s: ThiefState,
  userId: string,
  pos: (userId: string) => ThiefPos | null,
  now: number,
): boolean {
  if (!s.players.includes(userId)) return true;
  s.players = s.players.filter((id) => id !== userId);
  if (s.starterId === userId && s.players.length) s.starterId = s.players[0];
  if (s.holderId === userId) {
    const p = pos(userId);
    if (p) s.ball = { x: p.x, z: p.z };
    s.holderId = null;
    emit(s, 'drop', null, userId, now);
  }
  const live = s.phase === 'kickoff' || s.phase === 'playing';
  if ((live && s.players.length < THIEF_MIN_PLAYERS) || !s.players.length) {
    if (s.phase === 'playing') finishThief(s, now);
    else cancelThief(s, now);
    return false;
  }
  touch(s);
  return true;
}

export function finishThief(s: ThiefState, now: number): void {
  const ids = Object.keys(s.heldMs);
  const best = Math.max(0, ...ids.map((id) => s.heldMs[id] ?? 0));
  const winners = best > 0 ? ids.filter((id) => s.heldMs[id] === best) : [];
  let topStealer: string | null = null;
  for (const id of ids)
    if (
      (s.steals[id] ?? 0) > 0 &&
      (!topStealer || s.steals[id] > s.steals[topStealer])
    )
      topStealer = id;
  let longestId: string | null = null;
  for (const id of ids)
    if (
      (s.longestMs[id] ?? 0) > 0 &&
      (!longestId || s.longestMs[id] > s.longestMs[longestId])
    )
      longestId = id;
  s.result = {
    winners,
    topStealer,
    longestId,
    longestMs: longestId ? Math.round(s.longestMs[longestId]) : 0,
  };
  s.holderId = null;
  s.phase = 'ended';
  s.phaseUntil = now + THIEF_RESULT_MS;
  touch(s);
}

export function cancelThief(s: ThiefState, now: number): void {
  s.cancelled = true;
  s.holderId = null;
  s.result = null;
  s.phase = 'ended';
  s.phaseUntil = now + 2500;
  touch(s);
}

export type ThiefStep = 'none' | 'kickoff' | 'play' | 'finish' | 'drop';

export function thiefStep(s: ThiefState, now: number): ThiefStep {
  if (now < s.phaseUntil) return 'none';
  if (s.phase === 'gathering') return 'kickoff';
  if (s.phase === 'kickoff') return 'play';
  if (s.phase === 'playing') return 'finish';
  return 'drop';
}

function take(
  s: ThiefState,
  userId: string,
  kind: 'grab' | 'steal',
  from: string | null,
  now: number,
): void {
  s.holderId = userId;
  s.holdSince = now;
  s.immuneUntil = now + STEAL_IMMUNITY_MS;
  s.dodgeUntil = 0;
  emit(s, kind, userId, from, now);
}

function emit(
  s: ThiefState,
  kind: ThiefEventKind,
  by: string | null,
  from: string | null,
  at: number,
): void {
  s.event = { kind, by, from, at, seq: ++s.seq };
  touch(s);
}

function touch(s: ThiefState): void {
  s.rev++;
  s.dirty = true;
}

export interface ThiefView {
  type: 'lobby.thief.state';
  squadId: string;
  st: number;
  rev: number;
  round: number;
  starterId: string;
  phase: ThiefPhase;
  phaseUntil: number;
  playUntil: number;
  goldenAt: number;
  players: string[];
  holderId: string | null;
  holdSince: number;
  ball: ThiefPos;
  heldMs: Record<string, number>;
  steals: Record<string, number>;
  immuneUntil: number;
  dodgeUntil: number;
  cooldownUntil: Record<string, number>;
  dodgeReadyAt: Record<string, number>;
  event: ThiefEvent | null;
  result: ThiefResult | null;
  cancelled: boolean;
}

export function thiefView(s: ThiefState, now: number): ThiefView {
  return {
    type: 'lobby.thief.state',
    squadId: s.squadId,
    st: now,
    rev: s.rev,
    round: s.round,
    starterId: s.starterId,
    phase: s.phase,
    phaseUntil: s.phaseUntil,
    playUntil: s.playUntil,
    goldenAt: s.playUntil ? s.playUntil - THIEF_GOLDEN_MS : 0,
    players: [...s.players],
    holderId: s.holderId,
    holdSince: s.holdSince,
    ball: {
      x: Math.round(s.ball.x * 100) / 100,
      z: Math.round(s.ball.z * 100) / 100,
    },
    heldMs: Object.fromEntries(
      Object.entries(s.heldMs).map(([k, v]) => [k, Math.round(v)]),
    ),
    steals: { ...s.steals },
    immuneUntil: s.immuneUntil,
    dodgeUntil: s.dodgeUntil,
    cooldownUntil: { ...s.cooldownUntil },
    dodgeReadyAt: { ...s.dodgeReadyAt },
    event: s.event ? { ...s.event } : null,
    result: s.result ? { ...s.result, winners: [...s.result.winners] } : null,
    cancelled: s.cancelled,
  };
}
