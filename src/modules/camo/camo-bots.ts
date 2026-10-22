/**
 * Bots (section 12): they stand in for missing players and for dropped ones. They act only through the same entry
 * points a human uses (`acceptMove`, `acceptKick`, ...), see only what `canSee` lets them see, and draw every random
 * number from the match's seeded rng so a simulation replays exactly.
 */
import { CARD, MOVE, TAUNT, WHISTLE } from './camo-constants';
import { canSee } from './camo-hit';
import {
  acceptKick,
  acceptMove,
  acceptPaint,
  acceptTag,
  acceptTaunt,
  acceptWhistle,
  hidersAlive,
  playerById,
  seekers,
  setFreeze,
  setPose,
  type CamoMatch,
  type CamoPlayer,
} from './camo-rules';
import { buildWalkGrid, findPath, type CamoRoomData, type HideSpot, type WalkGrid } from './camo-room';
import type { WireStroke } from './camo-paint';

interface Mem {
  path: Array<{ x: number; z: number }>;
  step: number;
  spot: HideSpot | null;
  painted: boolean;
  settled: boolean;
  target: string | null;
  nextWaypointAt: number;
  lastPlanAt: number;
  panicUntil: number;
  seq: number;
  aimUntil: number;
}

const WALK_STEP_S = 0.1;

export class BotBrain {
  private readonly mem = new Map<string, Mem>();
  readonly grid: WalkGrid;

  constructor(private readonly room: CamoRoomData, grid?: WalkGrid) {
    this.grid = grid ?? buildWalkGrid(room);
  }

  private memOf(p: CamoPlayer): Mem {
    let m = this.mem.get(p.eid);
    if (!m) {
      m = { path: [], step: 0, spot: null, painted: false, settled: false, target: null, nextWaypointAt: 0, lastPlanAt: 0, panicUntil: 0, seq: 1, aimUntil: 0 };
      this.mem.set(p.eid, m);
    }
    return m;
  }

  /** Drives every bot of the match for one tick. */
  tick(match: CamoMatch, now: number): void {
    if (match.puzzle || match.tutorial) return; // scripted matches: the host moves the bot
    for (const p of match.players) {
      if (!(p.isBot || p.botCover)) continue;
      if (p.role === 'hider' && p.alive) this.hider(match, p, now);
      else if (p.role === 'seeker') this.seeker(match, p, now);
    }
  }

  // ── movement helpers ────────────────────────────────────────────────────

  private plan(m: Mem, from: { x: number; z: number }, to: { x: number; z: number }, now: number): void {
    m.path = findPath(this.grid, from, to) ?? [];
    m.step = 0;
    m.lastPlanAt = now;
  }

  /** One step along the path at walking pace (or a run for a chasing seeker). Returns true on arrival. */
  private follow(match: CamoMatch, p: CamoPlayer, m: Mem, now: number, run = false): boolean {
    if (!m.path.length || m.step >= m.path.length) return true;
    const speed = run ? MOVE.seekerRun : MOVE.walk;
    let budget = speed * WALK_STEP_S;
    let x = p.x;
    let z = p.z;
    while (budget > 0 && m.step < m.path.length) {
      const t = m.path[m.step];
      const dx = t.x - x;
      const dz = t.z - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d <= budget) {
        x = t.x;
        z = t.z;
        budget -= d;
        m.step++;
      } else {
        x += (dx / d) * budget;
        z += (dz / d) * budget;
        budget = 0;
      }
    }
    const yaw = Math.atan2(x - p.x, z - p.z);
    acceptMove(match, this.room, p.eid, { x, z, yaw: Number.isFinite(yaw) && (x !== p.x || z !== p.z) ? yaw : p.yaw, vx: (x - p.x) / WALK_STEP_S, vz: (z - p.z) / WALK_STEP_S, seq: ++m.seq + p.moveSeq, run }, now);
    return m.step >= m.path.length;
  }

  // ── hider ───────────────────────────────────────────────────────────────

  private pickSpot(match: CamoMatch, p: CamoPlayer): HideSpot {
    const taken = new Set(match.players.filter((q) => q !== p && q.spotId).map((q) => q.spotId));
    const maxDiff = 1 + Math.round(p.botSkill * 2);
    const pool = this.room.hideSpots.filter((s) => s.difficulty <= maxDiff && !taken.has(s.id));
    const list = pool.length ? pool : this.room.hideSpots;
    return list[Math.floor(match.rng() * list.length)];
  }

  /** Paint of a bot: the colour of the background, off by an error that shrinks with skill (section 12). */
  private paintFor(match: CamoMatch, p: CamoPlayer, spot: HideSpot): WireStroke[] {
    const err = (1 - p.botSkill) * 110;
    const jitter = (v: number): number => Math.max(0, Math.min(255, Math.round(v + (match.rng() - 0.5) * err)));
    const r = jitter((spot.color >> 16) & 255);
    const g = jitter((spot.color >> 8) & 255);
    const b = jitter(spot.color & 255);
    const fill: WireStroke = { kind: 'fill', x: 0, y: 0, z: 0, r: 1, rgb: (r << 16) | (g << 8) | b, rough: 200, hard: 255, nx: 0, ny: 0, nz: 0, seed: 0 };
    const strokes: WireStroke[] = [fill];
    const n = 4 + Math.floor(p.botSkill * 8);
    for (let i = 0; i < n; i++) {
      const y = 200 + Math.floor(match.rng() * 1200);
      const k = (match.rng() - 0.5) * 30;
      const col = (jitter(((spot.color >> 16) & 255) + k) << 16) | (jitter(((spot.color >> 8) & 255) + k) << 8) | jitter((spot.color & 255) + k);
      strokes.push({ kind: 'spray', x: Math.round((match.rng() - 0.5) * 400), y, z: Math.round((match.rng() - 0.5) * 300), r: 60, rgb: col, rough: 190, hard: 120, nx: 0, ny: 0, nz: 0, seed: Math.floor(match.rng() * 65535) });
    }
    return strokes;
  }

  private hider(match: CamoMatch, p: CamoPlayer, now: number): void {
    const m = this.memOf(p);
    if (match.phase === 'prep' || match.phase === 'whistle' || match.phase === 'hunt') {
      if (!m.spot) {
        m.spot = this.pickSpot(match, p);
        p.spotId = m.spot.id;
        this.plan(m, p, m.spot, now);
      }
      if (!m.settled) {
        const arrived = this.follow(match, p, m, now);
        if (arrived) {
          m.settled = true;
          setPose(match, p.eid, m.spot.poses[Math.floor(match.rng() * m.spot.poses.length)], now);
          if (match.phase === 'prep' && !m.painted) {
            acceptPaint(match, p.eid, this.paintFor(match, p, m.spot), now);
            m.painted = true;
          }
          setFreeze(match, this.room, p.eid, true, now);
        }
        return;
      }
    }
    if (match.phase !== 'hunt') return;
    // A real hider taunts when nobody is close, and a nervous one bolts when a seeker comes too near.
    const near = seekers(match).reduce((d, s) => Math.min(d, Math.hypot(s.x - p.x, s.z - p.z)), Infinity);
    if (near > TAUNT.range * 0.6 && match.rng() < 0.002 + (1 - p.botSkill) * 0.002) acceptTaunt(match, p.eid, now);
    if (near < 3.2 && p.frozen && now > m.panicUntil && match.rng() < 0.03 * (1 - p.botSkill)) {
      setFreeze(match, this.room, p.eid, false, now);
      m.spot = this.pickSpot(match, p);
      p.spotId = m.spot.id;
      this.plan(m, p, m.spot, now);
      m.settled = false;
      m.painted = true;
      m.panicUntil = now + 8_000;
    }
  }

  // ── seeker ──────────────────────────────────────────────────────────────

  private seeker(match: CamoMatch, p: CamoPlayer, now: number): void {
    if (match.phase !== 'hunt' || p.suspendedUntil > now) return;
    const m = this.memOf(p);
    const dt = WALK_STEP_S;
    const skill = p.botSkill;
    const room = this.room;
    // noticing: only hiders that could be seen at all, harder when well camouflaged and still
    if (!m.target) {
      for (const h of hidersAlive(match)) {
        if (!canSee(room, p, h, 16, 110)) continue;
        const d = Math.hypot(h.x - p.x, h.z - p.z);
        const moving = !h.frozen;
        const base = 0.18 + 0.55 * skill;
        const rate = base * (1 - h.stats.camo * 0.85) * Math.max(0.05, 1 - d / 16) * (moving ? 3 : 1) * (d < 2.5 ? 2.5 : 1);
        if (match.rng() < 1 - Math.exp(-rate * dt)) {
          m.target = h.eid;
          m.aimUntil = now + 600 + (1 - skill) * 900;
          break;
        }
      }
    }
    const target = m.target ? playerById(match, m.target) : undefined;
    if (target && (!target.alive || target.role !== 'hider')) m.target = null;
    if (target && target.alive && m.target) {
      const d = Math.hypot(target.x - p.x, target.z - p.z);
      const los = canSee(room, p, target, 18, 360);
      if (!los && now > m.aimUntil + 4000) {
        m.target = null;
        return;
      }
      if (d <= 1.3) {
        acceptTag(match, p.eid, now);
        return;
      }
      if (los && d <= 11 && now >= m.aimUntil) {
        // aim with an error that grows with distance and shrinks with skill
        const sigma = (1 - skill) * 0.9 * (d / 8);
        const ax = target.x + (match.rng() - 0.5) * 2 * sigma - p.x;
        const az = target.z + (match.rng() - 0.5) * 2 * sigma - p.z;
        const l = Math.hypot(ax, az) || 1;
        const res = acceptKick(match, room, p.eid, { origin: { x: p.x, y: 1.1, z: p.z }, dir: [ax / l, -0.04, az / l], power: 1, lob: false, seq: ++m.seq }, now);
        if (res) {
          m.aimUntil = now + 900;
          return;
        }
      }
      // close in on the target
      if (now - m.lastPlanAt > 700 || !m.path.length) this.plan(m, p, target, now);
      this.follow(match, p, m, now, true);
      return;
    }
    // patrol: visit hide spots in a random order, blow the whistle when it is ready and nobody is in sight
    if (now >= p.whistleReadyAt && match.rng() < 0.01 + skill * 0.01) acceptWhistle(match, p.eid, now);
    if (!m.path.length || m.step >= m.path.length || now > m.nextWaypointAt) {
      const s = room.hideSpots[Math.floor(match.rng() * room.hideSpots.length)];
      this.plan(m, p, s, now);
      m.nextWaypointAt = now + 9_000;
    }
    this.follow(match, p, m, now, false);
  }

  forget(eid: string): void {
    this.mem.delete(eid);
  }

  /** Clears everything between rounds (entity ids change, so old memory would never be read again anyway). */
  reset(): void {
    this.mem.clear();
  }
}

export { BOT_NAMES_AR } from './bot-names';

export { CARD, WHISTLE };
