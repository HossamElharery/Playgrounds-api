/**
 * The rules of «استغماية»: pure, deterministic (every random draw comes from the match's seeded `rng`) and free of
 * Nest, sockets and the database. The host feeds it moves and kicks, calls `step` every tick, and drains `outbox`.
 */
import { newModeration, type ModerationState } from './camo-moderation';
import {
  AWARDS,
  CARD,
  MAX_PLAYERS,
  MIN_PLAYERS,
  MOVE,
  POINTS,
  ROUNDS_PER_MATCH,
  SCAN,
  TAUNT,
  TIMERS,
  TOUCH_UP_MS,
  WHISTLE,
  seekerCount,
  type CamoAward,
  type CamoMode,
  type CamoPhase,
  type CamoPoseId,
  type CamoRole,
  POSE_IDS,
} from './camo-constants';
import { canSee, inForbiddenZone, kickOriginOk, tagHits, travelBudget } from './camo-hit';
import { launchVelocity, simulateShot, type BallEvent, type BallKeyframe } from './camo-ball-sim';
import { emptyPaintBook, estimateCamo, acceptStrokes, type PaintBook, type WireStroke } from './camo-paint';
import { pushOut, type CamoRoomData } from './camo-room';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlayerStats {
  nearDangerMs: number;
  tauntCount: number;
  redCards: number;
  yellowCards: number;
  firstRedAtMs: number | null;
  farthestRed: number;
  caughtByRicochet: boolean;
  caughtAfterTauntMs: number | null;
  survivedMs: number;
  /** Server's own estimate (0..1) used by the bots and the "golden chameleon". */
  camo: number;
}

export interface CamoPlayer {
  /** Entity id: changes every round, never reveals who is behind it. */
  eid: string;
  userId: string | null;
  name: string;
  isBot: boolean;
  botSkill: number;
  morphId: string;
  guest: boolean;
  /** How a `classic` body looks (the player's avatar config); null for the catalogue morphs. */
  look: unknown;
  /** Party members share one vote (section 17a). */
  partyId: string | null;
  deviceId: string | null;
  role: CamoRole;
  /** Seekers this player was in earlier rounds (priority goes to the ones who have not). */
  seekerRounds: number;
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  running: boolean;
  moveSeq: number;
  lastMoveAt: number;
  budget: number;
  pose: CamoPoseId;
  frozen: boolean;
  alive: boolean;
  caughtAt: number | null;
  caughtBy: string | null;
  yellows: number;
  suspendedUntil: number;
  stamina: number;
  recoverUntil: number;
  paint: PaintBook;
  paintStartedAt: number;
  touchUpUntil: number;
  touchUpUsed: boolean;
  ballReadyAt: number;
  tagReadyAt: number;
  tauntReadyAt: number;
  tauntAt: number;
  whistleReadyAt: number;
  scanReadyAt: number;
  lastSeenAt: number;
  connected: boolean;
  heldUntil: number;
  /** A bot stood in for a human who dropped. */
  botCover: boolean;
  spotId: string | null;
  loaded: boolean;
  points: number;
  total: number;
  stats: PlayerStats;
  lastInputAt: number;
  /** The client said it is talking (a flag only, never audio): until when. Used for proximity voice and report context. */
  speakingUntil: number;
  /** Seats this player silenced for themselves only (eids). */
  localMuted: Set<string>;
  /** Totals over the rounds of this match (what is stored when it ends). */
  match: { roles: CamoRole[]; caught: number; cardsGiven: number; yellows: number; bestSurvivalMs: number; awards: CamoAward[] };
}

export type CamoEvent =
  | { t: 'phase'; phase: CamoPhase; round: number; endsAt: number }
  | { t: 'ball'; by: string; seq: number; keyframes: BallKeyframe[]; events: BallEvent[]; at: number }
  | { t: 'card'; kind: 'red' | 'yellow'; target: string | null; by: string; at: number; ricochet?: boolean }
  | { t: 'caught'; eid: string; by: string; at: number }
  | { t: 'suspend'; eid: string; until: number }
  | { t: 'whistle'; by: string; at: number }
  | { t: 'whistle.noise'; at: number; positions: Array<{ eid: string; x: number; z: number }> }
  | { t: 'taunt'; eid: string; x: number; z: number; at: number }
  | { t: 'scan'; by: string; flashed: string[]; at: number }
  | { t: 'stoppage'; endsAt: number }
  | { t: 'role'; eid: string; role: CamoRole; round: number }
  | { t: 'infected'; eid: string; at: number }
  | { t: 'round.end'; round: number; winner: 'hiders' | 'seekers' }
  | { t: 'match.end' };

export interface HistoryFrame {
  t: number;
  pos: Record<string, [number, number]>;
}

export interface RoundAward {
  award: CamoAward;
  eid: string;
}

export interface RoundSummary {
  round: number;
  winner: 'hiders' | 'seekers';
  startedAt: number;
  huntStartedAt: number;
  endedAt: number;
  roles: Record<string, CamoRole>;
  awards: RoundAward[];
  points: Record<string, number>;
  /** Hider facts for the VAR, in the order the camera should visit them. */
  var: VarEntry[];
}

export interface VarEntry {
  eid: string;
  survivedMs: number | null;
  caughtAtMs: number | null;
  caughtBy: string | null;
  spotId: string | null;
  pose: CamoPoseId;
  x: number;
  z: number;
  camo: number;
  /** The closest a seeker came without seeing them: seconds into the hunt and the distance. */
  closest: { atMs: number; distance: number; seeker: string } | null;
  award: CamoAward | null;
}

/** A one-seeker puzzle (link challenge or daily): one hidden bot that never moves, 60 s, 3 wrong tags. */
export interface PuzzleState {
  puzzleId: string;
  x: number;
  z: number;
  yaw: number;
  pose: CamoPoseId;
  strokes: WireStroke[];
  morphId: string;
  maxMisses: number;
  misses: number;
  failed: boolean;
  foundMs: number | null;
}

export interface CamoMatch {
  id: string;
  roomId: string;
  mode: CamoMode;
  isPrivate: boolean;
  code: string | null;
  hostId: string | null;
  locked: boolean;
  timers: { prepMs: number; huntMs: number };
  botsAllowed: boolean;
  botTarget: number;
  createdAt: number;
  startedAt: number;
  phase: CamoPhase;
  phaseEndsAt: number;
  round: number;
  rounds: RoundSummary[];
  players: CamoPlayer[];
  nextEid: number;
  rng: () => number;
  seed: number;
  huntStartedAt: number;
  stoppageUsed: boolean;
  lastTickAt: number;
  ballSeq: number;
  history: HistoryFrame[];
  lastHistoryAt: number;
  closest: Map<string, { atMs: number; distance: number; seeker: string }>;
  outbox: CamoEvent[];
  endedAt: number | null;
  varSkipVotes: Set<string>;
  /** Private rooms: who was banned from this room instance (user ids). */
  banned: Set<string>;
  /** Room votes, mutes and cooldowns (section 17a). */
  mod: ModerationState;
  puzzle: PuzzleState | null;
  /** The creator of a link challenge: alone, hiding with the full prep time, until they press "make challenge". */
  creator: boolean;
}

export interface NewPlayer {
  userId: string | null;
  name: string;
  isBot: boolean;
  botSkill?: number;
  morphId: string;
  guest?: boolean;
  look?: unknown;
  partyId?: string | null;
  deviceId?: string | null;
}

export function createMatch(opts: {
  id: string;
  room: CamoRoomData;
  mode?: CamoMode;
  isPrivate?: boolean;
  code?: string | null;
  hostId?: string | null;
  timers?: Partial<{ prepMs: number; huntMs: number }>;
  botsAllowed?: boolean;
  botTarget?: number;
  seed: number;
  now: number;
}): CamoMatch {
  const clamp = (v: number | undefined, lo: number, hi: number, d: number): number =>
    v === undefined || !Number.isFinite(v) ? d : Math.min(hi, Math.max(lo, v));
  return {
    id: opts.id,
    roomId: opts.room.id,
    mode: opts.mode ?? 'classic',
    isPrivate: !!opts.isPrivate,
    code: opts.code ?? null,
    hostId: opts.hostId ?? null,
    locked: false,
    timers: {
      prepMs: clamp(opts.timers?.prepMs, TIMERS.prepMinMs, TIMERS.prepMaxMs, TIMERS.prepMs),
      huntMs: clamp(opts.timers?.huntMs, TIMERS.huntMinMs, TIMERS.huntMaxMs, TIMERS.huntMs),
    },
    botsAllowed: opts.botsAllowed ?? true,
    botTarget: clamp(opts.botTarget, 0, MAX_PLAYERS, 8),
    createdAt: opts.now,
    startedAt: 0,
    phase: 'waiting',
    phaseEndsAt: opts.now + TIMERS.waitingMaxMs,
    round: 0,
    rounds: [],
    players: [],
    nextEid: 1,
    rng: mulberry32(opts.seed),
    seed: opts.seed,
    huntStartedAt: 0,
    stoppageUsed: false,
    lastTickAt: opts.now,
    ballSeq: 0,
    history: [],
    lastHistoryAt: 0,
    closest: new Map(),
    outbox: [],
    endedAt: null,
    varSkipVotes: new Set(),
    banned: new Set(),
    mod: newModeration(),
    puzzle: null,
    creator: false,
  };
}

const emptyStats = (): PlayerStats => ({
  nearDangerMs: 0,
  tauntCount: 0,
  redCards: 0,
  yellowCards: 0,
  firstRedAtMs: null,
  farthestRed: 0,
  caughtByRicochet: false,
  caughtAfterTauntMs: null,
  survivedMs: 0,
  camo: 0,
});

export function addPlayer(m: CamoMatch, np: NewPlayer, now: number): CamoPlayer | null {
  if (m.players.length >= MAX_PLAYERS) return null;
  if (np.userId && m.banned.has(np.userId)) return null;
  if (np.userId && m.players.some((p) => p.userId === np.userId)) return null;
  const p: CamoPlayer = {
    eid: `e${m.nextEid++}`,
    userId: np.userId,
    name: np.name,
    isBot: np.isBot,
    botSkill: np.botSkill ?? 0.5,
    morphId: np.morphId,
    guest: !!np.guest,
    look: np.look ?? null,
    partyId: np.partyId ?? null,
    deviceId: np.deviceId ?? null,
    role: 'spectator',
    seekerRounds: 0,
    x: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vz: 0,
    running: false,
    moveSeq: 0,
    lastMoveAt: now,
    budget: 1,
    pose: 'stand',
    frozen: false,
    alive: true,
    caughtAt: null,
    caughtBy: null,
    yellows: 0,
    suspendedUntil: 0,
    stamina: MOVE.runSeconds,
    recoverUntil: 0,
    paint: emptyPaintBook(),
    paintStartedAt: 0,
    touchUpUntil: 0,
    touchUpUsed: false,
    ballReadyAt: 0,
    tagReadyAt: 0,
    tauntReadyAt: 0,
    tauntAt: 0,
    whistleReadyAt: 0,
    scanReadyAt: 0,
    lastSeenAt: 0,
    connected: true,
    heldUntil: 0,
    botCover: false,
    spotId: null,
    loaded: np.isBot,
    points: 0,
    total: 0,
    stats: emptyStats(),
    lastInputAt: now,
    speakingUntil: 0,
    localMuted: new Set(),
    match: { roles: [], caught: 0, cardsGiven: 0, yellows: 0, bestSurvivalMs: 0, awards: [] },
  };
  m.players.push(p);
  return p;
}

export const playerById = (m: CamoMatch, eid: string): CamoPlayer | undefined => m.players.find((p) => p.eid === eid);
export const playerByUser = (m: CamoMatch, userId: string): CamoPlayer | undefined => m.players.find((p) => p.userId === userId);
export const humans = (m: CamoMatch): CamoPlayer[] => m.players.filter((p) => !p.isBot && !p.botCover);
export const hidersAlive = (m: CamoMatch): CamoPlayer[] => m.players.filter((p) => p.role === 'hider' && p.alive);
export const seekers = (m: CamoMatch): CamoPlayer[] => m.players.filter((p) => p.role === 'seeker');

// ── phases ───────────────────────────────────────────────────────────────────

function setPhase(m: CamoMatch, phase: CamoPhase, now: number, ms: number): void {
  m.phase = phase;
  m.phaseEndsAt = now + ms;
  m.outbox.push({ t: 'phase', phase, round: m.round, endsAt: m.phaseEndsAt });
}

/** Can the match start? Real players plus bots (when allowed) must reach the minimum. */
export function canStart(m: CamoMatch): boolean {
  const total = m.players.length;
  return total >= MIN_PLAYERS;
}

/** Fills the room with bots up to the target (public: after the wait; private: the host's bot count). */
export function fillWithBots(m: CamoMatch, now: number, names: (i: number) => string, morphs: readonly string[]): number {
  if (!m.botsAllowed) return 0;
  const want = Math.max(MIN_PLAYERS, m.botTarget);
  let added = 0;
  while (m.players.length < want && m.players.length < MAX_PLAYERS) {
    const morph = morphs[Math.floor(m.rng() * morphs.length)] ?? 'classic';
    const p = addPlayer(m, { userId: null, name: names(m.players.length), isBot: true, botSkill: 0.3 + m.rng() * 0.5, morphId: morph }, now);
    if (!p) break;
    added++;
  }
  return added;
}

/** Roles of a round: the ones who were not a seeker yet go first, ties by the seeded draw (bots and humans alike). */
export function assignRoles(m: CamoMatch): void {
  const eligible = m.players.filter((p) => p.connected || p.botCover || p.isBot);
  const order = eligible
    .map((p) => ({ p, k: p.seekerRounds * 10 + m.rng() * 5 }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.p);
  const n = seekerCount(eligible.length);
  const seekerSet = new Set(order.slice(0, n).map((p) => p.eid));
  for (const p of m.players) {
    p.role = !eligible.includes(p) ? 'spectator' : seekerSet.has(p.eid) ? 'seeker' : 'hider';
    if (p.role === 'seeker') p.seekerRounds++;
  }
}

function resetForRound(m: CamoMatch, room: CamoRoomData, now: number): void {
  const spawnsH = room.spawns.hiders;
  const spawnsS = room.spawns.seekers;
  let h = 0;
  let s = 0;
  // New entity ids every round: a seeker cannot link last round's ids to this round's.
  const shuffled = m.players.map((p) => p).sort(() => m.rng() - 0.5);
  shuffled.forEach((p) => (p.eid = `e${m.nextEid++}`));
  for (const p of m.players) {
    p.alive = true;
    p.caughtAt = null;
    p.caughtBy = null;
    p.yellows = 0;
    p.suspendedUntil = 0;
    p.stamina = MOVE.runSeconds;
    p.recoverUntil = 0;
    p.paint = emptyPaintBook();
    p.touchUpUsed = false;
    p.touchUpUntil = 0;
    p.pose = 'stand';
    p.frozen = false;
    p.points = 0;
    p.stats = emptyStats();
    p.spotId = null;
    if (!p.isBot && p.connected) p.botCover = false;
    p.vx = p.vz = 0;
    p.ballReadyAt = 0;
    p.tagReadyAt = 0;
    p.tauntReadyAt = 0;
    p.whistleReadyAt = 0;
    p.scanReadyAt = 0;
    p.lastSeenAt = 0;
    p.budget = 1;
    p.lastMoveAt = now;
    p.lastInputAt = now;
    if (p.role === 'seeker') {
      const sp = spawnsS[s++ % spawnsS.length];
      p.x = sp.x;
      p.z = sp.z;
    } else {
      const sp = spawnsH[h++ % spawnsH.length];
      p.x = sp.x;
      p.z = sp.z;
    }
    p.yaw = p.role === 'seeker' ? Math.PI / 2 : 0;
  }
  m.closest = new Map();
  m.history = [];
  m.huntStartedAt = 0;
  m.stoppageUsed = false;
  m.varSkipVotes = new Set();
}

function placePuzzleHider(m: CamoMatch): void {
  const pz = m.puzzle!;
  const h = m.players.find((p) => p.isBot);
  if (!h) return;
  h.x = pz.x;
  h.z = pz.z;
  h.yaw = pz.yaw;
  h.pose = pz.pose;
  h.frozen = true;
  h.loaded = true;
  h.paint = { strokes: [...pz.strokes], bytes: 2, stamps: 0 };
}

export function startRound(m: CamoMatch, room: CamoRoomData, now: number): void {
  m.round++;
  if (!m.startedAt) m.startedAt = now;
  if (m.puzzle) {
    for (const p of m.players) p.role = p.isBot ? 'hider' : 'seeker';
  } else if (m.creator) {
    for (const p of m.players) p.role = 'hider';
  } else assignRoles(m);
  resetForRound(m, room, now);
  if (m.puzzle) placePuzzleHider(m);
  for (const p of m.players) m.outbox.push({ t: 'role', eid: p.eid, role: p.role, round: m.round });
  setPhase(m, 'reveal', now, TIMERS.revealMs);
}

// ── movement and inputs ─────────────────────────────────────────────────────

export interface MoveInput {
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  seq: number;
  run?: boolean;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function acceptMove(m: CamoMatch, room: CamoRoomData, eid: string, mv: MoveInput, now: number): { x: number; z: number; corrected: boolean } | null {
  const p = playerById(m, eid);
  if (!p || !finite(mv.x) || !finite(mv.z) || !finite(mv.yaw)) return null;
  if (!(mv.seq > p.moveSeq || p.moveSeq - mv.seq > 0x7fffffff)) return null;
  if (p.role === 'spectator' || (p.role === 'hider' && !p.alive)) return null;
  if (m.phase === 'reveal' || m.phase === 'var' || m.phase === 'results' || m.phase === 'waiting' || m.phase === 'ended') return null;
  if (p.role === 'seeker' && (m.phase === 'prep' || m.phase === 'whistle')) return null;
  if (p.suspendedUntil > now) return null;
  p.lastInputAt = now;
  const dt = Math.max(0, now - p.lastMoveAt);
  p.budget = Math.min(travelBudget(1000, false) * 2, p.budget + (dt / 1000) * MOVE.walk * MOVE.slack);
  const wantsRun = !!mv.run && p.role === 'seeker' && now >= p.recoverUntil && p.stamina > 0;
  const cap = travelBudget(dt + 100, wantsRun);
  let x = mv.x;
  let z = mv.z;
  const dx = x - p.x;
  const dz = z - p.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  let corrected = false;
  if (dist > cap) {
    const k = cap / dist;
    x = p.x + dx * k;
    z = p.z + dz * k;
    corrected = true;
  }
  const safe = pushOut(room, x, z);
  if (safe.x !== x || safe.z !== z) corrected = true;
  p.x = safe.x;
  p.z = safe.z;
  p.yaw = mv.yaw;
  p.vx = finite(mv.vx) ? mv.vx : 0;
  p.vz = finite(mv.vz) ? mv.vz : 0;
  p.moveSeq = mv.seq;
  p.lastMoveAt = now;
  // Stamina only drains while really moving fast.
  if (wantsRun && dist > 0.02) {
    p.running = true;
    p.stamina = Math.max(0, p.stamina - dt / 1000);
    if (p.stamina <= 0) p.recoverUntil = now + MOVE.recoverSeconds * 1000;
  } else {
    p.running = false;
    if (now >= p.recoverUntil) p.stamina = Math.min(MOVE.runSeconds, p.stamina + (dt / 1000) * (MOVE.runSeconds / MOVE.recoverSeconds));
  }
  // A hider that walks gives up its pose: only a still hider is a statue.
  if (p.role === 'hider' && p.frozen && dist > 0.05) p.frozen = false;
  return { x: p.x, z: p.z, corrected };
}

export function setPose(m: CamoMatch, eid: string, pose: string, now: number): boolean {
  const p = playerById(m, eid);
  if (!p || p.role !== 'hider' || !p.alive || (m.phase !== 'prep' && m.phase !== 'hunt')) return false;
  if (!(POSE_IDS as readonly string[]).includes(pose)) return false;
  p.pose = pose as CamoPoseId;
  p.lastInputAt = now;
  return true;
}

/** Freeze: only outside the forbidden zones (the referees' room and 5 m around its door). */
export function setFreeze(m: CamoMatch, room: CamoRoomData, eid: string, on: boolean, now: number): boolean {
  const p = playerById(m, eid);
  if (!p || p.role !== 'hider' || !p.alive || (m.phase !== 'prep' && m.phase !== 'hunt')) return false;
  if (on && inForbiddenZone(room, p)) return false;
  p.frozen = on;
  p.lastInputAt = now;
  return true;
}

export function acceptPaint(m: CamoMatch, eid: string, strokes: readonly WireStroke[], now: number): { accepted: WireStroke[]; rejected: number } | null {
  const p = playerById(m, eid);
  if (!p || p.role !== 'hider' || !p.alive) return null;
  const inPrep = m.phase === 'prep';
  const inTouchUp = m.phase === 'hunt' && now < p.touchUpUntil;
  if (!inPrep && !inTouchUp) return null;
  p.lastInputAt = now;
  return acceptStrokes(p.paint, strokes);
}

/** The player redrew their whole paint (undo / clear): the book is replaced by what the server accepts. */
export function resetPaint(m: CamoMatch, eid: string, strokes: readonly WireStroke[], now: number): { accepted: WireStroke[]; rejected: number } | null {
  const p = playerById(m, eid);
  if (!p || p.role !== 'hider' || !p.alive) return null;
  const inPrep = m.phase === 'prep';
  const inTouchUp = m.phase === 'hunt' && now < p.touchUpUntil;
  if (!inPrep && !inTouchUp) return null;
  p.lastInputAt = now;
  p.paint = emptyPaintBook();
  return acceptStrokes(p.paint, strokes);
}

/** The single 5 s repair touch of the hunt (section 5.1). */
export function beginTouchUp(m: CamoMatch, eid: string, now: number): boolean {
  const p = playerById(m, eid);
  if (!p || p.role !== 'hider' || !p.alive || m.phase !== 'hunt' || p.touchUpUsed) return false;
  p.touchUpUsed = true;
  p.touchUpUntil = now + TOUCH_UP_MS;
  return true;
}

// ── cards ───────────────────────────────────────────────────────────────────

function giveYellow(m: CamoMatch, s: CamoPlayer, now: number): void {
  if (m.puzzle) {
    // a puzzle has its own 3 misses: no suspension, the round is lost on the last one
    m.puzzle.misses++;
    m.outbox.push({ t: 'card', kind: 'yellow', target: null, by: s.eid, at: now });
    if (m.puzzle.misses >= m.puzzle.maxMisses) m.puzzle.failed = true;
    return;
  }
  s.yellows++;
  s.stats.yellowCards++;
  s.points += POINTS.yellowCard;
  m.outbox.push({ t: 'card', kind: 'yellow', target: null, by: s.eid, at: now });
  if (s.yellows >= CARD.yellowsForSuspension) {
    s.yellows = 0;
    s.suspendedUntil = now + CARD.suspensionMs;
    m.outbox.push({ t: 'suspend', eid: s.eid, until: s.suspendedUntil });
  }
}

function giveRed(m: CamoMatch, s: CamoPlayer, h: CamoPlayer, now: number, ricochet: boolean, distance: number): void {
  if (!h.alive) return;
  if (m.puzzle) m.puzzle.foundMs = Math.max(0, now - m.huntStartedAt);
  h.alive = false;
  h.caughtAt = now;
  h.caughtBy = s.eid;
  h.frozen = false;
  h.stats.survivedMs = Math.max(0, now - m.huntStartedAt);
  if (ricochet) h.stats.caughtByRicochet = true;
  if (h.tauntAt && now - h.tauntAt < 10_000) h.stats.caughtAfterTauntMs = now - h.tauntAt;
  s.stats.redCards++;
  if (s.stats.firstRedAtMs === null) s.stats.firstRedAtMs = Math.max(0, now - m.huntStartedAt);
  s.stats.farthestRed = Math.max(s.stats.farthestRed, distance);
  const remainingS = Math.max(0, (m.phaseEndsAt - now) / 1000);
  s.points += POINTS.redCard + Math.floor(remainingS / 3) * POINTS.redCardSpeedPer3s;
  m.outbox.push({ t: 'card', kind: 'red', target: h.eid, by: s.eid, at: now, ricochet });
  m.outbox.push({ t: 'caught', eid: h.eid, by: s.eid, at: now });
  if (m.mode === 'contagion') {
    h.role = 'seeker';
    h.alive = true;
    h.stats.survivedMs = Math.max(0, now - m.huntStartedAt);
    m.outbox.push({ t: 'infected', eid: h.eid, at: now });
  }
}

export interface KickInput {
  origin: { x: number; y: number; z: number };
  dir: [number, number, number];
  power: number;
  lob: boolean;
  seq: number;
}

/** A seeker's shot. The server simulates it and decides every card; the client only draws. */
export function acceptKick(m: CamoMatch, room: CamoRoomData, eid: string, k: KickInput, now: number): { hit: number; ball: boolean } | null {
  const s = playerById(m, eid);
  if (!s || s.role !== 'seeker' || m.phase !== 'hunt' || s.suspendedUntil > now || now < s.ballReadyAt) return null;
  if (!k.origin || !finite(k.origin.x) || !finite(k.origin.y) || !finite(k.origin.z) || !k.dir || k.dir.length !== 3 || !k.dir.every(finite)) return null;
  if (!kickOriginOk(s, k.origin)) return null;
  const oy = Math.min(2, Math.max(0.3, k.origin.y));
  const v = launchVelocity(k.dir[0], k.dir[1], k.dir[2], k.power, k.lob, CARD.shotSpeed, CARD.lobMaxSpeed);
  const targets = hidersAlive(m).map((h, i) => ({ id: i, x: h.x, z: h.z }));
  const list = hidersAlive(m);
  s.lastInputAt = now;
  const shot = simulateShot(room, { x: k.origin.x, y: oy, z: k.origin.z }, v, targets);
  m.ballSeq++;
  m.outbox.push({ t: 'ball', by: s.eid, seq: k.seq, keyframes: shot.keyframes, events: shot.events, at: now });
  let hits = 0;
  for (const ev of shot.events) {
    if (ev.kind !== 'hit' || ev.target === undefined) continue;
    const h = list[ev.target];
    if (!h || !h.alive) continue;
    const d = Math.sqrt((h.x - k.origin.x) ** 2 + (h.z - k.origin.z) ** 2);
    giveRed(m, s, h, now + Math.round(ev.t * 1000), !!ev.ricochet, d);
    hits++;
  }
  if (!hits) giveYellow(m, s, now + Math.round(shot.end.t * 1000));
  const firstHitT = shot.events.find((e) => e.kind === 'hit')?.t ?? shot.events.find((e) => e.kind === 'bounce')?.t;
  const flight = Math.min(CARD.ballMaxFlightMs, (firstHitT ?? shot.end.t) * 1000);
  s.ballReadyAt = now + flight + CARD.ballReturnMs;
  return { hit: hits, ball: true };
}

/** The close-range grab: a 0.4 s lunge, then every hider in the cone is out. */
export function acceptTag(m: CamoMatch, eid: string, now: number): { hit: number } | null {
  const s = playerById(m, eid);
  if (!s || s.role !== 'seeker' || m.phase !== 'hunt' || s.suspendedUntil > now || now < s.tagReadyAt) return null;
  s.lastInputAt = now;
  s.tagReadyAt = now + CARD.tagCooldownMs;
  let hits = 0;
  for (const h of hidersAlive(m)) {
    if (!tagHits(s, h)) continue;
    const d = Math.sqrt((h.x - s.x) ** 2 + (h.z - s.z) ** 2);
    giveRed(m, s, h, now, false, d);
    hits++;
  }
  if (!hits) giveYellow(m, s, now);
  return { hit: hits };
}

export function acceptWhistle(m: CamoMatch, eid: string, now: number): boolean {
  const s = playerById(m, eid);
  if (!s || s.role !== 'seeker' || m.phase !== 'hunt' || s.suspendedUntil > now || now < s.whistleReadyAt) return false;
  s.whistleReadyAt = now + WHISTLE.everyMs;
  s.lastInputAt = now;
  m.outbox.push({ t: 'whistle', by: s.eid, at: now });
  const positions: Array<{ eid: string; x: number; z: number }> = [];
  for (const h of hidersAlive(m)) {
    const d = Math.sqrt((h.x - s.x) ** 2 + (h.z - s.z) ** 2);
    if (d > WHISTLE.range) continue;
    // The noise gives a direction, not a spot: it is off by up to 3 m.
    positions.push({ eid: h.eid, x: h.x + (m.rng() - 0.5) * 6, z: h.z + (m.rng() - 0.5) * 6 });
  }
  m.outbox.push({ t: 'whistle.noise', at: now, positions });
  return true;
}

export function acceptScan(m: CamoMatch, eid: string, now: number, enabled = true): boolean {
  const s = playerById(m, eid);
  if (!enabled || !s || s.role !== 'seeker' || m.phase !== 'hunt' || s.suspendedUntil > now || now < s.scanReadyAt) return false;
  s.scanReadyAt = now + SCAN.everyMs;
  s.lastInputAt = now;
  const flashed = hidersAlive(m)
    .filter((h) => {
      const d = Math.sqrt((h.x - s.x) ** 2 + (h.z - s.z) ** 2);
      return d <= SCAN.range && !h.frozen && (Math.abs(h.vx) > 0.05 || Math.abs(h.vz) > 0.05);
    })
    .map((h) => h.eid);
  m.outbox.push({ t: 'scan', by: s.eid, flashed, at: now });
  return true;
}

export function acceptTaunt(m: CamoMatch, eid: string, now: number): boolean {
  const p = playerById(m, eid);
  if (!p || p.role !== 'hider' || !p.alive || m.phase !== 'hunt' || now < p.tauntReadyAt) return false;
  p.tauntReadyAt = now + TAUNT.cooldownMs;
  p.tauntAt = now;
  p.stats.tauntCount++;
  p.lastInputAt = now;
  m.outbox.push({ t: 'taunt', eid: p.eid, x: p.x, z: p.z, at: now });
  return true;
}

// ── per-tick scoring ────────────────────────────────────────────────────────

function tickScoring(m: CamoMatch, room: CamoRoomData, now: number, dtMs: number): void {
  const dt = dtMs / 1000;
  const seekerList = seekers(m);
  for (const h of hidersAlive(m)) {
    let danger = false;
    let seen = false;
    for (const s of seekerList) {
      const d = Math.sqrt((h.x - s.x) ** 2 + (h.z - s.z) ** 2);
      const sees = canSee(room, s, h, 18, 110);
      if (sees) {
        seen = true;
        h.lastSeenAt = now;
      }
      if (d <= POINTS.dangerRange && !sees) {
        danger = true;
        const best = m.closest.get(h.eid);
        if (!best || d < best.distance) m.closest.set(h.eid, { atMs: Math.max(0, now - m.huntStartedAt), distance: d, seeker: s.eid });
      }
    }
    void seen;
    h.points += (danger ? POINTS.dangerMultiplier : 1) * POINTS.hiderSecond * dt;
    if (danger) h.stats.nearDangerMs += dtMs;
    h.stats.survivedMs = Math.max(0, now - m.huntStartedAt);
    h.stats.camo = h.stats.camo || 0;
  }
}

/** Hiders that a seeker saw during the last 10 s: the stoppage-time rule. */
function lastHiderSeenRecently(m: CamoMatch, now: number): boolean {
  const left = hidersAlive(m);
  return left.length === 1 && left[0].lastSeenAt > 0 && now - left[0].lastSeenAt <= 10_000;
}

// ── step ────────────────────────────────────────────────────────────────────

/** Advances the match to `now`. Returns true while the match is still alive. */
export function step(m: CamoMatch, room: CamoRoomData, now: number): boolean {
  const dtMs = Math.max(0, now - m.lastTickAt);
  m.lastTickAt = now;
  if (m.phase === 'ended') return false;

  // Seat holds end: a bot takes the place of a dropped human.
  for (const p of m.players) {
    if (!p.isBot && !p.connected && !p.botCover && p.heldUntil && now >= p.heldUntil) {
      p.botCover = true;
      p.botSkill = Math.max(p.botSkill, 0.5);
    }
  }

  switch (m.phase) {
    case 'waiting':
      return true;
    case 'reveal':
      if (now >= m.phaseEndsAt) {
        for (const p of m.players) if (p.role === 'hider') p.paintStartedAt = now;
        setPhase(m, 'prep', now, m.timers.prepMs);
        setSeekersInRoom(m, room);
      }
      return true;
    case 'prep': {
      if (m.creator) {
        // the creator hides for as long as they need (the room closes if they leave)
        if (now >= m.phaseEndsAt) m.phaseEndsAt = now + 60_000;
        return true;
      }
      if (now >= m.phaseEndsAt) {
        setPhase(m, 'whistle', now, TIMERS.whistleMs);
        for (const h of m.players) if (h.role === 'hider' && !h.frozen && !inForbiddenZone(room, h)) h.frozen = false;
        // Anybody still hiding in a forbidden spot is evicted before the whistle.
        for (const h of m.players) {
          if (h.role !== 'hider' || !inForbiddenZone(room, h)) continue;
          const out = room.spawns.hiders[0];
          h.x = out.x;
          h.z = out.z;
        }
      } else setSeekersInRoom(m, room);
      return true;
    }
    case 'whistle':
      if (now >= m.phaseEndsAt) {
        m.huntStartedAt = now;
        for (const p of m.players) if (p.role === 'hider') p.stats.camo = estimateCamo(p.paint, spotColor(room, p));
        setPhase(m, 'hunt', now, m.timers.huntMs);
      }
      return true;
    case 'hunt': {
      tickScoring(m, room, now, dtMs);
      if (now - m.lastHistoryAt >= 200) {
        m.lastHistoryAt = now;
        const frame: HistoryFrame = { t: Math.max(0, now - m.huntStartedAt), pos: {} };
        for (const p of m.players) if (p.role !== 'spectator') frame.pos[p.eid] = [Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100];
        m.history.push(frame);
        if (m.history.length > 1600) m.history.shift();
      }
      const left = hidersAlive(m);
      const anySeeker = seekers(m).length > 0;
      if (!left.length && m.mode === 'classic') return endRound(m, room, now, 'seekers'), true;
      if (m.mode === 'contagion' && !m.players.some((p) => p.role === 'hider' && p.alive)) return endRound(m, room, now, 'seekers'), true;
      if (!anySeeker || m.puzzle?.failed) return endRound(m, room, now, 'hiders'), true;
      if (now >= m.phaseEndsAt) {
        if (!m.stoppageUsed && lastHiderSeenRecently(m, now)) {
          m.stoppageUsed = true;
          m.phaseEndsAt = now + TIMERS.stoppageMs;
          m.outbox.push({ t: 'stoppage', endsAt: m.phaseEndsAt });
        } else endRound(m, room, now, 'hiders');
      }
      return true;
    }
    case 'var':
      if (now >= m.phaseEndsAt || everyHumanSkipped(m)) {
        setPhase(m, 'results', now, TIMERS.resultsMs);
      }
      return true;
    case 'results':
      if (now >= m.phaseEndsAt) {
        if (m.round >= (m.puzzle ? 1 : ROUNDS_PER_MATCH)) {
          m.phase = 'ended';
          m.endedAt = now;
          m.outbox.push({ t: 'match.end' });
          return false;
        }
        startRound(m, room, now);
      }
      return true;
    default:
      return true;
  }
}

function nearestSpot(room: CamoRoomData, p: CamoPlayer): string | null {
  let best: string | null = null;
  let bd = Infinity;
  for (const s of room.hideSpots) {
    const d = (s.x - p.x) ** 2 + (s.z - p.z) ** 2;
    if (d < bd) {
      bd = d;
      best = s.id;
    }
  }
  return bd < 4 ? best : null;
}

function spotColor(room: CamoRoomData, p: CamoPlayer): number {
  const spot = room.hideSpots.reduce<{ d: number; c: number }>(
    (best, s) => {
      const d = (s.x - p.x) ** 2 + (s.z - p.z) ** 2;
      return d < best.d ? { d, c: s.color } : best;
    },
    { d: Infinity, c: 0x808080 },
  );
  return spot.c;
}

/** Seekers wait in the referees' room while the others paint: put back anybody who drifted. */
function setSeekersInRoom(m: CamoMatch, room: CamoRoomData): void {
  const r = room.refereeRoom;
  for (const s of seekers(m)) {
    if (s.x < r.minX + 0.4 || s.x > r.maxX - 0.4 || s.z < r.minZ + 0.4 || s.z > r.maxZ - 0.4) {
      const sp = room.spawns.seekers[0];
      s.x = sp.x;
      s.z = sp.z;
    }
  }
}

function everyHumanSkipped(m: CamoMatch): boolean {
  const hs = humans(m).filter((p) => p.connected);
  return hs.length > 0 && hs.every((p) => p.userId && m.varSkipVotes.has(p.userId));
}

export function voteVarSkip(m: CamoMatch, userId: string): void {
  if (m.phase !== 'var') return;
  m.varSkipVotes.add(userId);
}

// ── round end, awards ───────────────────────────────────────────────────────

function endRound(m: CamoMatch, room: CamoRoomData, now: number, winner: 'hiders' | 'seekers'): void {
  const endedAt = now;
  for (const h of m.players) {
    if (h.role === 'hider' && h.alive) {
      h.stats.survivedMs = Math.max(0, now - m.huntStartedAt);
      if (winner === 'hiders') h.points += POINTS.lastHider;
    }
  }
  const awards = computeAwards(m);
  for (const h of m.players) if (h.role === 'hider' || h.caughtAt !== null) h.spotId = h.spotId ?? nearestSpot(room, h);
  const entries = buildVar(m, awards, now);
  const roles: Record<string, CamoRole> = {};
  const pts: Record<string, number> = {};
  for (const p of m.players) {
    roles[p.eid] = p.role;
    pts[p.eid] = Math.round(p.points);
    p.total += Math.round(p.points);
    p.match.roles.push(p.role);
    if (p.caughtAt !== null) p.match.caught++;
    p.match.cardsGiven += p.stats.redCards;
    p.match.yellows += p.stats.yellowCards;
    if (p.role === 'hider' || p.caughtAt !== null) p.match.bestSurvivalMs = Math.max(p.match.bestSurvivalMs, p.stats.survivedMs);
    for (const a of awards) if (a.eid === p.eid) p.match.awards.push(a.award);
  }
  m.rounds.push({
    round: m.round,
    winner,
    startedAt: m.startedAt,
    huntStartedAt: m.huntStartedAt,
    endedAt,
    roles,
    awards,
    points: pts,
    var: entries,
  });
  m.outbox.push({ t: 'round.end', round: m.round, winner });
  setPhase(m, 'var', now, TIMERS.varMs);
}

export function computeAwards(m: CamoMatch): RoundAward[] {
  const out: RoundAward[] = [];
  const hiders = m.players.filter((p) => p.stats !== undefined && (p.role === 'hider' || p.caughtAt !== null));
  const seekersAll = m.players.filter((p) => p.role === 'seeker');
  const best = <T>(list: T[], score: (x: T) => number, min = 0): T | null => {
    let top: T | null = null;
    let topScore = -Infinity;
    for (const x of list) {
      const s = score(x);
      if (s > topScore) {
        top = x;
        topScore = s;
      }
    }
    return top && topScore > min ? top : null;
  };
  const survivors = hiders.filter((h) => h.alive && h.caughtAt === null);
  const gold = best(survivors, (h) => h.stats.camo, 0.0);
  if (gold) out.push({ award: 'golden_chameleon', eid: gold.eid });
  const five = best(hiders, (h) => h.stats.nearDangerMs, 7_999);
  if (five) out.push({ award: 'passed_by_five_times', eid: five.eid });
  const fast = best(hiders.filter((h) => h.caughtAt !== null), (h) => -(h.caughtAt! - m.huntStartedAt), -Infinity);
  if (fast) out.push({ award: 'caught_before_hiding', eid: fast.eid });
  const unfair = best(seekersAll, (s) => s.stats.yellowCards, 1);
  if (unfair) out.push({ award: 'unfair_referee', eid: unfair.eid });
  const eagle = best(seekersAll, (s) => s.stats.redCards, 0);
  if (eagle) out.push({ award: 'eagle_eye', eid: eagle.eid });
  const over = best(hiders, (h) => (h.stats.caughtAfterTauntMs !== null ? 1 : 0), 0);
  if (over) out.push({ award: 'overconfident', eid: over.eid });
  const mistake = hiders.find((h) => h.stats.caughtByRicochet);
  if (mistake) out.push({ award: 'caught_by_mistake', eid: mistake.eid });
  const sniper = best(seekersAll, (s) => s.stats.farthestRed, 0);
  if (sniper) out.push({ award: 'sniper', eid: sniper.eid });
  // keep the declared order of AWARDS stable
  return out.sort((a, b) => AWARDS.indexOf(a.award) - AWARDS.indexOf(b.award));
}

/** The VAR visits the survivors first (the most exciting), then the caught ones from the latest backwards. */
export function buildVar(m: CamoMatch, awards: RoundAward[], now: number): VarEntry[] {
  const hiders = m.players.filter((p) => p.role === 'hider' || p.caughtAt !== null);
  const survivors = hiders.filter((h) => h.caughtAt === null);
  const caught = hiders.filter((h) => h.caughtAt !== null).sort((a, b) => b.caughtAt! - a.caughtAt!);
  return [...survivors, ...caught].map((h) => {
    const c = m.closest.get(h.eid) ?? null;
    return {
      eid: h.eid,
      survivedMs: h.caughtAt === null ? Math.max(0, now - m.huntStartedAt) : null,
      caughtAtMs: h.caughtAt === null ? null : Math.max(0, h.caughtAt - m.huntStartedAt),
      caughtBy: h.caughtBy,
      spotId: h.spotId,
      pose: h.pose,
      x: Math.round(h.x * 100) / 100,
      z: Math.round(h.z * 100) / 100,
      camo: h.stats.camo,
      closest: c,
      award: awards.find((a) => a.eid === h.eid)?.award ?? null,
    };
  });
}

/** Ranking of a finished match (ties keep the same rank). */
export function ranking(m: CamoMatch): Array<{ eid: string; total: number; rank: number }> {
  const sorted = m.players.slice().sort((a, b) => b.total - a.total);
  let rank = 0;
  let last = Number.NaN;
  return sorted.map((p, i) => {
    if (p.total !== last) {
      rank = i + 1;
      last = p.total;
    }
    return { eid: p.eid, total: p.total, rank };
  });
}
