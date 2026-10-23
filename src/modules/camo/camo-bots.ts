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
  acceptDisguise,
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
import { copyable } from './camo-disguise';

interface Mem {
  path: Array<{ x: number; z: number }>;
  step: number;
  spot: HideSpot | null;
  painted: boolean;
  startAt: number;
  visited: Set<string>;
  paintAt: number;
  settled: boolean;
  target: string | null;
  nextWaypointAt: number;
  lastPlanAt: number;
  panicUntil: number;
  seq: number;
  aimUntil: number;
}

const WALK_STEP_S = 0.1;

/** How quickly a referee bot notices a hider it can see (per second, before distance and camouflage). Tuned so a real player hiding well wins about half the rounds. */
/** Share of patrol legs that head for a part of the room where a hider really is (keeps the hunt lively in a big hall). */
export const HUNCH = 0.3;
export const NOTICE = { base: 0.24, perSkill: 0.6, camoEffect: 0.72 };

export class BotBrain {
  private readonly mem = new Map<string, Mem>();
  readonly grid: WalkGrid;

  /** A big hall needs a keener referee: it feels where people are more often and sees further (a small room is left as is). */
  private readonly hunch: number;
  private readonly sight: number;

  constructor(private readonly room: CamoRoomData, grid?: WalkGrid) {
    this.grid = grid ?? buildWalkGrid(room);
    const area = (room.bounds.maxX - room.bounds.minX) * (room.bounds.maxZ - room.bounds.minZ);
    const big = Math.max(0, Math.min(1, (area - 900) / 1000));
    this.hunch = HUNCH + big * 0.4;
    this.sight = 16 + big * 8;
  }

  private memOf(p: CamoPlayer): Mem {
    let m = this.mem.get(p.eid);
    if (!m) {
      m = { path: [], step: 0, spot: null, painted: false, startAt: 0, visited: new Set<string>(), paintAt: 0, settled: false, target: null, nextWaypointAt: 0, lastPlanAt: 0, panicUntil: 0, seq: 1, aimUntil: 0 };
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

  private readonly crowdCache = new Map<string, number>();

  /** How many more of the same kind stand around the best copyable object at a spot (0 when there is nothing to copy). */
  private crowdAt(s: HideSpot): number {
    let v = this.crowdCache.get(s.id);
    if (v === undefined) {
      v = 0;
      for (const [i] of copyable(this.room, s.x, s.z).slice(0, 6)) {
        const t = this.room.props[i];
        let n = 0;
        for (let j = 0; j < this.room.props.length; j++) {
          const q = this.room.props[j];
          if (j !== i && q.type === t.type && Math.hypot(q.x - s.x, q.z - s.z) < 7) n++;
        }
        v = Math.max(v, Math.min(n, 8));
      }
      this.crowdCache.set(s.id, v);
    }
    return v;
  }

  /** A spot nobody else is at or next to; better bots lean towards the harder (more tucked-away) ones. */
  private pickSpot(match: CamoMatch, p: CamoPlayer): HideSpot {
    const taken = match.players.filter((q) => q !== p && q.spotId).map((q) => this.room.hideSpots.find((s) => s.id === q.spotId)).filter((s): s is HideSpot => !!s);
    const free = this.room.hideSpots.filter((s) => !taken.some((t) => Math.hypot(t.x - s.x, t.z - s.z) < 1.4));
    // a spot is only worth walking to when there is something to copy within reach of it
    const copyableFree = free.filter((s) => this.crowdAt(s) >= 0 && copyable(this.room, s.x, s.z).length > 0);
    const list = copyableFree.length ? copyableFree : free.length ? free : this.room.hideSpots;
    const weights = list.map((s) => 1 + (s.difficulty - 1) * p.botSkill * 2.2 + this.crowdAt(s) * 0.5 * p.botSkill);
    let r = match.rng() * weights.reduce((t, w) => t + w, 0);
    for (let i = 0; i < list.length; i++) {
      r -= weights[i];
      if (r <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  /** The object a bot copies from where it stands: the type with most more of its kind around, never a lone one. */
  private bestCopy(match: CamoMatch, p: CamoPlayer): number {
    const near = copyable(this.room, p.x, p.z);
    if (!near.length) return -1;
    const crowd = (i: number): number => {
      const t = this.room.props[i];
      let n = 0;
      for (let j = 0; j < this.room.props.length; j++) {
        const q = this.room.props[j];
        if (j !== i && q.type === t.type && Math.hypot(q.x - p.x, q.z - p.z) < 7) n++;
      }
      return n;
    };
    // a sharper bot copies from the biggest crowd; a careless one takes whatever is nearest
    const scored = near.slice(0, 8).map(([i, d]) => ({ i, s: crowd(i) * (0.4 + p.botSkill) - d * 0.35 + match.rng() * (1.2 - p.botSkill) * 2 }));
    scored.sort((a, b) => b.s - a.s);
    return scored[0].i;
  }

  private hider(match: CamoMatch, p: CamoPlayer, now: number): void {
    const m = this.memOf(p);
    if (match.phase !== 'prep' && match.phase !== 'whistle' && match.phase !== 'hunt') return;
    // once settled a hider never moves again: not after the whistle, not when a referee comes close
    if (m.settled) {
      if (!m.painted && m.spot && now >= m.paintAt) {
        const i = this.bestCopy(match, p);
        if (i >= 0) acceptDisguise(match, this.room, p.eid, i, now);
        m.painted = true;
      }
      if (match.phase === 'hunt' && p.botSkill < 0.4 && match.rng() < 0.0005) acceptTaunt(match, p.eid, now);
      return;
    }
    if (!m.spot) {
      m.spot = this.pickSpot(match, p);
      p.spotId = m.spot.id;
      this.plan(m, p, m.spot, now);
      // a human-looking pause before setting off, a share of the preparation time
      const prep = Math.max(1000, match.phaseEndsAt - now);
      m.startAt = now + match.rng() * Math.min(4000, prep * 0.12);
      m.paintAt = 0;
    }
    if (now < m.startAt) return;
    const arrived = this.follow(match, p, m, now);
    if (!arrived) {
      // late for the whistle: stop where it stands rather than walk through the hunt
      if (match.phase !== 'prep') {
        m.settled = true;
        m.painted = true;
        setFreeze(match, this.room, p.eid, true, now);
      }
      return;
    }
    m.settled = true;
    // back to the surface, facing out like a person leaning on it
    p.yaw = Math.atan2(m.spot.nx, m.spot.nz);
    const poses = m.spot.poses.length ? m.spot.poses : ['stand'];
    setPose(match, p.eid, poses[Math.floor(match.rng() * poses.length)], now);
    const left = Math.max(0, match.phaseEndsAt - now);
    m.paintAt = match.phase === 'prep' ? now + Math.min(left * 0.5, 1500 + match.rng() * 4500) : now;
    setFreeze(match, this.room, p.eid, true, now);
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
        if (!canSee(room, p, h, this.sight, 110)) continue;
        const d = Math.hypot(h.x - p.x, h.z - p.z);
        const moving = !h.frozen;
        const base = NOTICE.base + NOTICE.perSkill * skill;
        const rate = base * (1 - h.stats.camo * NOTICE.camoEffect) * Math.max(0.05, 1 - d / this.sight) * (moving ? 3 : 1) * (d < 2.5 ? 2.5 : 1);
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
    // patrol: sweep the hide spots nearest-first (each looked at once), blow the whistle when it is ready and nobody is in sight
    if (now >= p.whistleReadyAt && match.rng() < 0.004) acceptWhistle(match, p.eid, now);
    for (const sp of room.hideSpots) if (!m.visited.has(sp.id) && Math.hypot(sp.x - p.x, sp.z - p.z) < 3) m.visited.add(sp.id);
    if (!m.path.length || m.step >= m.path.length || now > m.nextWaypointAt) {
      let pool = room.hideSpots.filter((sp) => !m.visited.has(sp.id));
      if (!pool.length) {
        m.visited.clear();
        pool = room.hideSpots;
      }
      // a hunch: now and then a referee heads for a part of the room where somebody really is (a good referee «feels» it);
      // otherwise it sweeps the nearest places. Either way it only walks, it never aims at what it cannot see.
      const prey = hidersAlive(match);
      if (prey.length && match.rng() < this.hunch) {
        const h = prey[Math.floor(match.rng() * prey.length)];
        const near = pool.filter((sp) => Math.hypot(sp.x - h.x, sp.z - h.z) < 9);
        if (near.length) pool = near;
      }
      pool = pool.map((sp) => ({ sp, d: Math.hypot(sp.x - p.x, sp.z - p.z) + match.rng() * 6 })).sort((a, b) => a.d - b.d).slice(0, 4).map((x) => x.sp);
      const s2 = pool[Math.floor(match.rng() * pool.length)];
      this.plan(m, p, s2, now);
      m.nextWaypointAt = now + 9_000;
    }
    // long legs are run (the stamina rule still applies), short ones walked so the referee can look about
    const leg = m.path.length ? Math.hypot(m.path[m.path.length - 1].x - p.x, m.path[m.path.length - 1].z - p.z) : 0;
    this.follow(match, p, m, now, leg > 7);
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
