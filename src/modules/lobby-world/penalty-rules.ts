import { GOAL_HALF_WIDTH, GOAL_LINE_Z } from './ball-sim';

export const PENALTY_SPOT = { x: 0, z: GOAL_LINE_Z + 4.4 } as const;
export const SHOOTER_SPOT = { x: 0, z: PENALTY_SPOT.z + 0.8 } as const;
export const KEEPER_SPOT = { x: 0, z: GOAL_LINE_Z + 0.45 } as const;
export const KEEPER_BOX = {
  minX: -(GOAL_HALF_WIDTH + 0.35),
  maxX: GOAL_HALF_WIDTH + 0.35,
  minZ: GOAL_LINE_Z + 0.2,
  maxZ: GOAL_LINE_Z + 1.1,
} as const;
export const SHOOTER_BOX = {
  minX: -1.6,
  maxX: 1.6,
  minZ: PENALTY_SPOT.z + 0.3,
  maxZ: PENALTY_SPOT.z + 3,
} as const;

export const SETUP_MS = 7000;
export const ARRIVE_DISTANCE = 0.4;
export const AIM_MS = 8000;
export const FLIGHT_MS = 3500;
export const RESULT_MS = 2600;
export const ENDED_MS = 9000;
export const GATHERING_MS = 12000;
export const PENALTY_MIN_PLAYERS = 2;
export const PENALTY_MAX_PLAYERS = 6;
export const MAX_SUDDEN_DEATH_ROUNDS = 3;
export const DIVE_DISTANCE = 1.4;
export const DIVE_MS = 450;
export const DIVE_GROUND_MS = 600;

export interface PenaltyDive {
  dir: -1 | 0 | 1;
  at: number;
  x: number;
  z: number;
  finished: boolean;
}

export function divePose(dive: PenaltyDive, now: number): { x: number; z: number; r: number; locked: boolean } {
  const elapsed = Math.max(0, now - dive.at);
  const t = Math.min(1, elapsed / DIVE_MS);
  const eased = 1 - (1 - t) * (1 - t) * (1 - t);
  return {
    x: Math.max(KEEPER_BOX.minX, Math.min(KEEPER_BOX.maxX, dive.x + dive.dir * DIVE_DISTANCE * eased)),
    z: dive.z,
    r: elapsed < DIVE_MS + DIVE_GROUND_MS ? 0.55 : 0.3,
    locked: elapsed < DIVE_MS + DIVE_GROUND_MS,
  };
}

export type PenaltyPhase = 'gathering' | 'setup' | 'aim' | 'flight' | 'result' | 'ended';
export type PenaltyOutcome = 'goal' | 'saved' | 'missed' | 'timeout';

export interface PenaltyState {
  squadId: string;
  starterId: string;
  order: string[];
  candidates: string[];
  accepted: string[];
  declined: string[];
  spectatorSpots: Record<string, { x: number; z: number }>;
  rounds: number;
  stageShots: Record<string, number>;
  kickers: string[];
  suddenDeath: number;
  shooterId: string;
  keeperId: string;
  phase: PenaltyPhase;
  phaseUntil: number;
  goals: Record<string, number>;
  shots: Record<string, PenaltyOutcome[]>;
  lastOutcome: PenaltyOutcome | null;
  lastPanenka: boolean;
  lastShooterId: string | null;
  winners: string[];
  cancelled: boolean;
  /** Ended because the others left, not because the shootout was played out. */
  walkover: boolean;
  dive: PenaltyDive | null;
  rev: number;
}

export function roundsFor(players: number): number {
  return players <= 3 ? 5 : 3;
}

export function createPenalty(
  squadId: string,
  starterId: string,
  players: readonly string[],
  now: number,
): PenaltyState | null {
  const order = [...new Set(players)].slice(0, PENALTY_MAX_PLAYERS);
  if (order.length < PENALTY_MIN_PLAYERS) return null;
  const goals: Record<string, number> = {};
  const shots: Record<string, PenaltyOutcome[]> = {};
  for (const id of order) {
    goals[id] = 0;
    shots[id] = [];
  }
  const s: PenaltyState = {
    squadId,
    starterId,
    order,
    candidates: [...order],
    accepted: [...order],
    declined: [],
    spectatorSpots: Object.fromEntries(order.map((id, i) => [id, { x: i % 2 === 0 ? -3.5 : 3.5, z: Math.round((-1.5 + Math.floor(i / 2) * 1.2) * 100) / 100 }])),
    rounds: roundsFor(order.length),
    stageShots: Object.fromEntries(order.map((id) => [id, 0])),
    kickers: [...order],
    suddenDeath: 0,
    shooterId: '',
    keeperId: '',
    phase: 'setup',
    phaseUntil: 0,
    goals,
    shots,
    lastOutcome: null,
    lastPanenka: false,
    lastShooterId: null,
    winners: [],
    cancelled: false,
    walkover: false,
    dive: null,
    rev: 0,
  };
  beginTurn(s, now);
  return s;
}

function stageKicks(s: PenaltyState): number {
  return s.suddenDeath === 0 ? s.rounds : 1;
}

export function beginTurn(s: PenaltyState, now: number): void {
  s.dive = null;
  s.lastPanenka = false;
  let shooter = s.kickers[0];
  for (const id of s.kickers)
    if ((s.stageShots[id] ?? 0) < (s.stageShots[shooter] ?? 0)) shooter = id;
  const i = s.order.indexOf(shooter);
  let keeper = s.order[(i + 1) % s.order.length];
  if (keeper === shooter) keeper = s.order[(i + 2) % s.order.length];
  s.shooterId = shooter;
  s.keeperId = keeper;
  s.phase = 'setup';
  s.phaseUntil = now + SETUP_MS;
  s.rev++;
}

export function beginAim(s: PenaltyState, now: number): void {
  s.phase = 'aim';
  s.phaseUntil = now + AIM_MS;
  s.rev++;
}

export function beginDive(s: PenaltyState, userId: string, dir: number, x: number, z: number, now: number): boolean {
  if (userId !== s.keeperId || (s.phase !== 'aim' && s.phase !== 'flight') || s.dive || !Number.isInteger(dir) || dir < -1 || dir > 1) return false;
  s.dive = { dir: dir as -1 | 0 | 1, at: now, x, z, finished: false };
  s.rev++;
  return true;
}

export function beginFlight(s: PenaltyState, now: number): void {
  s.phase = 'flight';
  s.phaseUntil = now + FLIGHT_MS;
  s.rev++;
}

export function resolveShot(
  s: PenaltyState,
  outcome: PenaltyOutcome,
  now: number,
): void {
  const shooter = s.shooterId;
  s.shots[shooter]?.push(outcome);
  s.stageShots[shooter] = (s.stageShots[shooter] ?? 0) + 1;
  if (outcome === 'goal') s.goals[shooter] = (s.goals[shooter] ?? 0) + 1;
  s.lastOutcome = outcome;
  s.lastShooterId = shooter;
  s.phase = 'result';
  s.phaseUntil = now + RESULT_MS;
  s.rev++;
}

export function advance(s: PenaltyState, now: number): void {
  const done = s.kickers.every(
    (id) => (s.stageShots[id] ?? 0) >= stageKicks(s),
  );
  if (!done && !decidedEarly(s)) {
    beginTurn(s, now);
    return;
  }
  const leaders = leadersAmong(s, s.kickers);
  if (leaders.length === 1 || s.suddenDeath >= MAX_SUDDEN_DEATH_ROUNDS) {
    finish(s, leaders, now);
    return;
  }
  // Level: the tied players go again, one kick each per round.
  s.suddenDeath++;
  s.kickers = leaders;
  s.stageShots = Object.fromEntries(leaders.map((id) => [id, 0]));
  beginTurn(s, now);
}

export function decidedEarly(s: PenaltyState): boolean {
  if (s.suddenDeath > 0) return false;
  const leaders = leadersAmong(s, s.kickers);
  if (leaders.length !== 1) return false;
  const best = s.goals[leaders[0]] ?? 0;
  for (const id of s.kickers) {
    if (id === leaders[0]) continue;
    const left = s.rounds - (s.stageShots[id] ?? 0);
    if ((s.goals[id] ?? 0) + left >= best) return false;
  }
  return true;
}

export function leadersAmong(
  s: PenaltyState,
  ids: readonly string[],
): string[] {
  const best = Math.max(...ids.map((id) => s.goals[id] ?? 0));
  return ids.filter((id) => (s.goals[id] ?? 0) === best);
}

export function finish(s: PenaltyState, winners: string[], now: number): void {
  s.winners = winners;
  s.phase = 'ended';
  s.phaseUntil = now + ENDED_MS;
  s.rev++;
}

export function cancel(s: PenaltyState, now: number): void {
  s.cancelled = true;
  finish(s, [], now);
}

export function removePlayer(
  s: PenaltyState,
  userId: string,
  now: number,
): void {
  if (!s.order.includes(userId) || s.phase === 'ended') return;
  const inPair = s.shooterId === userId || s.keeperId === userId;
  s.order = s.order.filter((id) => id !== userId);
  s.kickers = s.kickers.filter((id) => id !== userId);
  if (s.order.length < PENALTY_MIN_PLAYERS) {
    cancel(s, now);
    return;
  }
  if (s.kickers.length === 1) {
    s.walkover = true;
    finish(s, [...s.kickers], now);
    return;
  }
  if (
    inPair &&
    (s.phase === 'setup' || s.phase === 'aim' || s.phase === 'flight')
  )
    beginTurn(s, now);
  else s.rev++;
}

export function clampToBox(
  x: number,
  z: number,
  box: { minX: number; maxX: number; minZ: number; maxZ: number },
): { x: number; z: number } | null {
  const cx = Math.min(box.maxX, Math.max(box.minX, x));
  const cz = Math.min(box.maxZ, Math.max(box.minZ, z));
  return cx === x && cz === z ? null : { x: cx, z: cz };
}

export interface PenaltyView {
  type: 'lobby.pen.state';
  squadId: string;
  st: number;
  rev: number;
  phase: PenaltyPhase;
  phaseUntil: number;
  order: string[];
  candidates?: string[];
  accepted?: string[];
  declined?: string[];
  spectatorSpots?: Record<string, { x: number; z: number }>;
  kickers: string[];
  rounds: number;
  suddenDeath: number;
  shooterId: string;
  keeperId: string;
  goals: Record<string, number>;
  shots: Record<string, PenaltyOutcome[]>;
  lastOutcome: PenaltyOutcome | null;
  lastPanenka?: boolean;
  lastShooterId: string | null;
  winners: string[];
  cancelled: boolean;
  dive?: PenaltyDive | null;
  starterId: string;
}

export function penaltyView(s: PenaltyState, now: number): PenaltyView {
  return {
    type: 'lobby.pen.state',
    squadId: s.squadId,
    st: now,
    rev: s.rev,
    phase: s.phase,
    phaseUntil: s.phaseUntil,
    order: [...s.order],
    candidates: [...s.candidates],
    accepted: [...s.accepted],
    declined: [...s.declined],
    spectatorSpots: { ...s.spectatorSpots },
    kickers: [...s.kickers],
    rounds: s.rounds,
    suddenDeath: s.suddenDeath,
    shooterId: s.shooterId,
    keeperId: s.keeperId,
    goals: { ...s.goals },
    shots: Object.fromEntries(
      Object.entries(s.shots).map(([k, v]) => [k, [...v]]),
    ),
    lastOutcome: s.lastOutcome,
    lastPanenka: s.lastPanenka,
    lastShooterId: s.lastShooterId,
    winners: [...s.winners],
    cancelled: s.cancelled,
    dive: s.dive ? { ...s.dive } : null,
    starterId: s.starterId,
  };
}
