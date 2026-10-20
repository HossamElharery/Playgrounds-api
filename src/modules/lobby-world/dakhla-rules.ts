/**
 * «الدخلة»: the lobby's rhythm game. The server owns the clock (when beat 0 plays), who is in, and the group's score;
 * every phone judges its own taps against the shared start time and reports running totals.
 */

/** Song lengths in ms; keep in sync with chantDurationMs() in the app (dakhla-chants.ts). */
export const DAKHLA_CHANT_MS = {
  nafas: 67826,
  hamia: 64286,
  finala: 65455,
} as const;
export type DakhlaChantId = keyof typeof DAKHLA_CHANT_MS;
export type DakhlaLevel = 1 | 2 | 3;

export const DAKHLA_GATHER_MS = 9000;
export const DAKHLA_COUNTDOWN_MS = 4200;
/** Time after the last beat for the last reports to land before the result. */
export const DAKHLA_TAIL_MS = 1800;
export const DAKHLA_RESULT_MS = 14000;
export const DAKHLA_MAX_PLAYERS = 12;
/** Late joiners can drop in until this share of the song has played (the raise is the last 15 %). */
export const DAKHLA_JOIN_UNTIL = 0.8;
export const DAKHLA_REPORT_MIN_MS = 350;
/** No chart has more notes than this, even on level 3. */
export const DAKHLA_MAX_NOTES = 400;
const GOOD_WEIGHT = 0.6;

export type DakhlaPhase = 'gathering' | 'playing' | 'ended';

export interface DakhlaMember {
  userId: string;
  level: DakhlaLevel;
  joinedAt: number;
  perfect: number;
  good: number;
  miss: number;
  combo: number;
  maxCombo: number;
  reportAt: number;
}

export interface DakhlaResult {
  acc: number;
  mvpId: string | null;
  comboId: string | null;
  nextCapoId: string;
  players: number;
}

export interface DakhlaState {
  squadId: string;
  round: number;
  capoId: string;
  chant: DakhlaChantId;
  phase: DakhlaPhase;
  phaseUntil: number;
  startAt: number;
  songMs: number;
  members: DakhlaMember[];
  result: DakhlaResult | null;
  cancelled: boolean;
  rev: number;
  dirty: boolean;
}

export interface DakhlaReport {
  perfect: number;
  good: number;
  miss: number;
  combo: number;
  maxCombo: number;
}

export function isChant(v: unknown): v is DakhlaChantId {
  return (
    typeof v === 'string' &&
    Object.prototype.hasOwnProperty.call(DAKHLA_CHANT_MS, v) === true
  );
}

export function parseLevel(v: unknown): DakhlaLevel {
  return v === 2 || v === 3 ? v : 1;
}

export function parseReport(v: unknown): DakhlaReport | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const n = (k: string) => {
    const x = o[k];
    return Number.isInteger(x) &&
      (x as number) >= 0 &&
      (x as number) <= DAKHLA_MAX_NOTES
      ? (x as number)
      : null;
  };
  const perfect = n('perfect');
  const good = n('good');
  const miss = n('miss');
  const combo = n('combo');
  const maxCombo = n('maxCombo');
  if (
    perfect === null ||
    good === null ||
    miss === null ||
    combo === null ||
    maxCombo === null
  )
    return null;
  const total = perfect + good + miss;
  if (total > DAKHLA_MAX_NOTES || combo > maxCombo || maxCombo > perfect + good)
    return null;
  return { perfect, good, miss, combo, maxCombo };
}

function member(userId: string, level: DakhlaLevel, now: number): DakhlaMember {
  return {
    userId,
    level,
    joinedAt: now,
    perfect: 0,
    good: 0,
    miss: 0,
    combo: 0,
    maxCombo: 0,
    reportAt: 0,
  };
}

export function createDakhla(
  squadId: string,
  capoId: string,
  chant: DakhlaChantId,
  level: DakhlaLevel,
  alone: boolean,
  now: number,
  round = 1,
): DakhlaState {
  const s: DakhlaState = {
    squadId,
    round,
    capoId,
    chant,
    phase: 'gathering',
    phaseUntil: now + DAKHLA_GATHER_MS,
    startAt: 0,
    songMs: DAKHLA_CHANT_MS[chant],
    members: [member(capoId, level, now)],
    result: null,
    cancelled: false,
    rev: 1,
    dirty: true,
  };
  // Nobody to wait for: count in straight away.
  if (alone) beginSong(s, now);
  return s;
}

export function beginSong(s: DakhlaState, now: number): void {
  s.phase = 'playing';
  s.startAt = now + DAKHLA_COUNTDOWN_MS;
  s.phaseUntil = s.startAt + s.songMs + DAKHLA_TAIL_MS;
  touch(s);
}

export function canJoin(s: DakhlaState, now: number): boolean {
  if (s.members.length >= DAKHLA_MAX_PLAYERS) return false;
  if (s.phase === 'gathering') return true;
  return (
    s.phase === 'playing' && now < s.startAt + s.songMs * DAKHLA_JOIN_UNTIL
  );
}

export function joinDakhla(
  s: DakhlaState,
  userId: string,
  level: DakhlaLevel,
  now: number,
): boolean {
  const known = s.members.find((m) => m.userId === userId);
  if (known) {
    if (s.phase === 'gathering' && known.level !== level) {
      known.level = level;
      touch(s);
    }
    return true;
  }
  if (!canJoin(s, now)) return false;
  s.members.push(member(userId, level, now));
  touch(s);
  return true;
}

/** Returns false when the session ends because nobody is left. */
export function leaveDakhla(
  s: DakhlaState,
  userId: string,
  now: number,
): boolean {
  const before = s.members.length;
  s.members = s.members.filter((m) => m.userId !== userId);
  if (s.members.length === before) return true;
  if (!s.members.length) {
    cancelDakhla(s, now);
    return false;
  }
  if (s.capoId === userId) s.capoId = s.members[0].userId;
  touch(s);
  return true;
}

export function reportDakhla(
  s: DakhlaState,
  userId: string,
  r: DakhlaReport,
  now: number,
): boolean {
  if (s.phase !== 'playing' || now < s.startAt) return false;
  const m = s.members.find((x) => x.userId === userId);
  if (!m || now - m.reportAt < DAKHLA_REPORT_MIN_MS) return false;
  // Totals only grow: a report can never take back a miss.
  if (
    r.perfect + r.good + r.miss < m.perfect + m.good + m.miss ||
    r.miss < m.miss ||
    r.maxCombo < m.maxCombo
  )
    return false;
  m.perfect = r.perfect;
  m.good = r.good;
  m.miss = r.miss;
  m.combo = r.combo;
  m.maxCombo = r.maxCombo;
  m.reportAt = now;
  touch(s);
  return true;
}

export function memberAccuracy(
  m: Pick<DakhlaMember, 'perfect' | 'good' | 'miss'>,
): number {
  const n = m.perfect + m.good + m.miss;
  return n ? (m.perfect + m.good * GOOD_WEIGHT) / n : 0;
}

/** Everybody's hits together, weighted by how many notes each played. */
export function groupAccuracy(members: readonly DakhlaMember[]): number {
  let hit = 0;
  let all = 0;
  for (const m of members) {
    hit += m.perfect + m.good * GOOD_WEIGHT;
    all += m.perfect + m.good + m.miss;
  }
  return all ? hit / all : 0;
}

export function finishDakhla(s: DakhlaState, now: number): void {
  const played = s.members.filter((m) => m.perfect + m.good + m.miss > 0);
  let mvp: DakhlaMember | null = null;
  let combo: DakhlaMember | null = null;
  for (const m of played) {
    if (
      !mvp ||
      memberAccuracy(m) > memberAccuracy(mvp) ||
      (memberAccuracy(m) === memberAccuracy(mvp) && m.maxCombo > mvp.maxCombo)
    )
      mvp = m;
    if (!combo || m.maxCombo > combo.maxCombo) combo = m;
  }
  s.result = {
    acc: Math.round(groupAccuracy(s.members) * 1000) / 1000,
    mvpId: mvp?.userId ?? null,
    comboId: combo?.userId ?? null,
    // The best player leads the next chant.
    nextCapoId: mvp?.userId ?? s.capoId,
    players: played.length,
  };
  s.phase = 'ended';
  s.phaseUntil = now + DAKHLA_RESULT_MS;
  touch(s);
}

export function cancelDakhla(s: DakhlaState, now: number): void {
  s.cancelled = true;
  s.result = null;
  s.phase = 'ended';
  s.phaseUntil = now + 2500;
  touch(s);
}

export type DakhlaStep = 'none' | 'begin' | 'finish' | 'drop';

/** What the timer should do now. */
export function dakhlaStep(s: DakhlaState, now: number): DakhlaStep {
  if (now < s.phaseUntil) return 'none';
  if (s.phase === 'gathering') return 'begin';
  if (s.phase === 'playing') return 'finish';
  return 'drop';
}

function touch(s: DakhlaState): void {
  s.rev++;
  s.dirty = true;
}

export interface DakhlaView {
  type: 'lobby.dak.state';
  squadId: string;
  st: number;
  rev: number;
  round: number;
  capoId: string;
  chant: DakhlaChantId;
  phase: DakhlaPhase;
  phaseUntil: number;
  startAt: number;
  songMs: number;
  acc: number;
  members: {
    userId: string;
    level: DakhlaLevel;
    acc: number;
    combo: number;
    maxCombo: number;
    played: number;
  }[];
  result: DakhlaResult | null;
  cancelled: boolean;
}

export function dakhlaView(s: DakhlaState, now: number): DakhlaView {
  return {
    type: 'lobby.dak.state',
    squadId: s.squadId,
    st: now,
    rev: s.rev,
    round: s.round,
    capoId: s.capoId,
    chant: s.chant,
    phase: s.phase,
    phaseUntil: s.phaseUntil,
    startAt: s.startAt,
    songMs: s.songMs,
    acc: Math.round(groupAccuracy(s.members) * 1000) / 1000,
    members: s.members.map((m) => ({
      userId: m.userId,
      level: m.level,
      acc: Math.round(memberAccuracy(m) * 1000) / 1000,
      combo: m.combo,
      maxCombo: m.maxCombo,
      played: m.perfect + m.good + m.miss,
    })),
    result: s.result ? { ...s.result } : null,
    cancelled: s.cancelled,
  };
}
