/**
 * What each player is allowed to know (section 8, 14 and 17). The server never sends a seeker the identity of a
 * hider during the hunt, nor anything that links a name or account to an entity id. Every payload that leaves the
 * host passes through here, and `camo-views.spec.ts` inspects the produced JSON for leaks.
 */
import { POSE_IDS, type CamoPhase, type CamoRole } from './camo-constants';
import { canSee } from './camo-hit';
import {
  seekers as seekersOf,
  type CamoMatch,
  type CamoPlayer,
  type RoundSummary,
  type VarEntry,
} from './camo-rules';
import type { CamoRoomData } from './camo-room';

export interface Viewer {
  userId: string | null;
  eid: string;
  role: CamoRole;
  /** A caught hider watches from the stands. */
  spectator: boolean;
}

export function viewerOf(p: CamoPlayer): Viewer {
  return { userId: p.userId, eid: p.eid, role: p.role, spectator: p.role === 'spectator' || (p.role === 'hider' && !p.alive) };
}

/** Seekers during prep/whistle/hunt must not learn who a hider is. */
export function huntBlind(m: CamoMatch, v: Viewer): boolean {
  return v.role === 'seeker' && (m.phase === 'prep' || m.phase === 'whistle' || m.phase === 'hunt');
}

export interface PlayerView {
  lv?: number;
  eq?: { ns?: string; rc?: string; vf?: string };
  eid: string;
  userId?: string;
  name?: string;
  isBot?: boolean;
  guest?: boolean;
  morphId: string;
  look?: unknown;
  role: CamoRole;
  alive: boolean;
}

export interface PlayersPayload {
  round: number;
  /** Who is who. For a hunting seeker the hiders appear without userId/name. */
  players: PlayerView[];
  /** Seekers only: every non-seeker's name, with nothing that ties a name to a position or entity. */
  roster?: Array<{ userId: string | null; name: string; isBot: boolean; guest: boolean }>;
}

export function playersFor(m: CamoMatch, v: Viewer): PlayersPayload {
  const blind = huntBlind(m, v);
  const players: PlayerView[] = [];
  for (const p of m.players) {
    const hidden = blind && p.role !== 'seeker' && p.eid !== v.eid;
    const base: PlayerView = { eid: p.eid, morphId: p.morphId, ...(p.look ? { look: p.look } : {}), role: hidden ? 'hider' : p.role, alive: p.alive || p.role === 'seeker' };
    if (!hidden || (p.role === 'hider' && !p.alive && p.caughtAt !== null)) {
      base.userId = p.userId ?? undefined;
      base.name = p.name;
      base.isBot = p.isBot;
      base.guest = p.guest;
      if (p.flair) {
        base.lv = p.flair.lv;
        base.eq = { ns: p.flair.eq['name_style'], rc: p.flair.eq['red_card_anim'], vf: p.flair.eq['var_frame'] };
      }
    }
    players.push(base);
  }
  const out: PlayersPayload = { round: m.round, players };
  if (blind) {
    out.roster = m.players
      .filter((p) => p.eid !== v.eid && p.role !== 'seeker')
      .map((p) => ({ userId: p.userId, name: p.name, isBot: p.isBot, guest: p.guest }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

/** Packed per-entity state. Flags: 1 frozen, 2 running, 4 suspended, 8 alive. */
export type PosTuple = [eid: string, x: number, z: number, yaw: number, vx: number, vz: number, flags: number, pose: number];

export function flagsOf(p: CamoPlayer, now: number): number {
  return (p.frozen ? 1 : 0) | (p.running ? 2 : 0) | (p.suspendedUntil > now ? 4 : 0) | (p.alive ? 8 : 0);
}

const SIGHT_RANGE = 45;
const NEAR_RANGE = 2.5;

/** Interest management: hunters and hiders only hear about bodies they could see, which also defeats wall-hacks. */
export function visibleTo(m: CamoMatch, room: CamoRoomData, v: Viewer, other: CamoPlayer): boolean {
  if (other.eid === v.eid) return true;
  if (v.spectator) return true;
  if (m.phase === 'waiting' || m.phase === 'reveal' || m.phase === 'var' || m.phase === 'results' || m.phase === 'ended') return true;
  if (other.role === 'seeker' && v.role === 'seeker') return true;
  const me = m.players.find((p) => p.eid === v.eid);
  if (!me) return false;
  const dx = other.x - me.x;
  const dz = other.z - me.z;
  if (dx * dx + dz * dz <= NEAR_RANGE * NEAR_RANGE) return true;
  return canSee(room, me, other, SIGHT_RANGE, 360);
}

export function positionsFor(m: CamoMatch, room: CamoRoomData, v: Viewer, now: number): PosTuple[] {
  const out: PosTuple[] = [];
  for (const p of m.players) {
    if (p.role === 'spectator') continue;
    if (!visibleTo(m, room, v, p)) continue;
    out.push([
      p.eid,
      Math.round(p.x * 100) / 100,
      Math.round(p.z * 100) / 100,
      Math.round(p.yaw * 100) / 100,
      Math.round(p.vx * 10) / 10,
      Math.round(p.vz * 10) / 10,
      flagsOf(p, now),
      Math.max(0, (POSE_IDS as readonly string[]).indexOf(p.pose)),
    ]);
  }
  return out;
}

export interface StateView {
  matchId: string;
  roomId: string;
  mode: string;
  isPrivate: boolean;
  code: string | null;
  hostId: string | null;
  locked: boolean;
  round: number;
  rounds: number;
  phase: CamoPhase;
  endsAt: number;
  you: { eid: string; role: CamoRole; suspendedUntil: number; yellows: number; stamina: number } | null;
  seekersLeft: number;
  hidersAlive: number;
  total: number;
  scores?: Record<string, number>;
  /** Set in a puzzle match: how many wrong tags are left and, once found, how long it took. */
  puzzle?: { misses: number; max: number; foundMs: number | null; failed: boolean };
}

export function stateFor(m: CamoMatch, v: Viewer | null, now: number): StateView {
  const me = v ? m.players.find((p) => p.eid === v.eid) : undefined;
  return {
    matchId: m.id,
    roomId: m.roomId,
    mode: m.puzzle ? 'puzzle' : m.tutorial ? 'tutorial' : m.creator ? 'creator' : m.mode,
    isPrivate: m.isPrivate,
    code: m.isPrivate ? m.code : null,
    hostId: m.hostId,
    locked: m.locked,
    round: m.round,
    rounds: m.puzzle || m.tutorial ? 1 : 3,
    phase: m.phase,
    endsAt: m.phaseEndsAt,
    you: me ? { eid: me.eid, role: me.role, suspendedUntil: me.suspendedUntil, yellows: me.yellows, stamina: Math.round(me.stamina * 10) / 10 } : null,
    seekersLeft: seekersOf(m).length,
    hidersAlive: m.players.filter((p) => p.role === 'hider' && p.alive).length,
    total: m.players.length,
    ...(m.puzzle ? { puzzle: { misses: m.puzzle.misses, max: m.puzzle.maxMisses, foundMs: m.puzzle.foundMs, failed: m.puzzle.failed } } : {}),
  };
}

/** What a client needs after a reconnect or a late join: the whole current picture at once. */
export interface SnapshotPayload {
  state: StateView;
  players: PlayersPayload;
  positions: PosTuple[];
  /** Paint of the hiders this viewer may know about, as the wire bytes. */
  paint: Array<{ eid: string; bytes: number }>;
}

export function paintTargets(m: CamoMatch, v: Viewer): CamoPlayer[] {
  // Seekers get no paint in prep (they are not looking); from the whistle on, every hider's.
  if (v.role === 'seeker' && m.phase === 'prep') return [];
  return m.players.filter((p) => p.role === 'hider' || (p.paint.strokes.length > 0 && p.role === 'spectator'));
}

// ── results (everything is revealed) ────────────────────────────────────────

export interface VarPayload {
  round: number;
  winner: 'hiders' | 'seekers';
  entries: Array<
    VarEntry & {
      name: string;
      userId: string | null;
      isBot: boolean;
      morphId: string;
    }
  >;
  awards: RoundSummary['awards'];
  points: Record<string, number>;
  totals: Record<string, number>;
  history: Array<{ t: number; pos: Record<string, [number, number]> }>;
}

export function varPayload(m: CamoMatch, round: RoundSummary): VarPayload {
  const byEid = new Map(m.players.map((p) => [p.eid, p]));
  return {
    round: round.round,
    winner: round.winner,
    entries: round.var.map((e) => {
      const p = byEid.get(e.eid);
      return { ...e, name: p?.name ?? '?', userId: p?.userId ?? null, isBot: p?.isBot ?? false, morphId: p?.morphId ?? 'classic' };
    }),
    awards: round.awards,
    points: round.points,
    totals: Object.fromEntries(m.players.map((p) => [p.eid, p.total])),
    history: m.history.filter((_, i) => i % 5 === 0),
  };
}
