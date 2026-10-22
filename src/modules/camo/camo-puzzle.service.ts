import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { CamoHost, CamoUser, JoinResult } from './camo-host';
import { decodeStrokes, encodeStrokes, MAX_WIRE_BYTES, type WireStroke } from './camo-paint';
import type { CamoMatch } from './camo-rules';
import { CamoSettingsService } from './camo-settings.service';

const DAY_MS = 86_400_000;
const CHALLENGE_DAYS = 14;

/** Cairo calendar day (yyyy-mm-dd): the daily Chameleon changes at midnight there (section 13). */
export function cairoDay(at = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

const shortId = (): string => randomBytes(6).toString('base64url');

/** Deterministic 0..1 stream from a string, so the bot's daily puzzle is the same for everyone and testable. */
export function seeded(text: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

@Injectable()
export class CamoPuzzleService {
  private readonly logger = new Logger(CamoPuzzleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CamoSettingsService,
  ) {}

  // ── challenges ─────────────────────────────────────────────────────────────

  /** The creator finished hiding: store where, how and what they look like, then close their room. */
  async createChallenge(host: CamoHost, userId: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    const snap = host.creatorSnapshot(userId);
    if (!snap) return { ok: false, reason: 'bad_spot' };
    const bytes = encodeStrokes(snap.strokes);
    if (bytes.byteLength > MAX_WIRE_BYTES) return { ok: false, reason: 'too_big' };
    const recent = await this.prisma.camoPuzzle.count({ where: { creatorId: userId, createdAt: { gt: new Date(Date.now() - DAY_MS) } } });
    if (recent >= 20) return { ok: false, reason: 'rate' };
    const id = shortId();
    await this.prisma.camoPuzzle.create({
      data: { id, kind: 'challenge', creatorId: userId, roomId: snap.roomId, x: snap.x, z: snap.z, yaw: snap.yaw, pose: snap.pose, morphId: snap.morphId, strokes: Buffer.from(bytes), source: 'player', expiresAt: new Date(Date.now() + CHALLENGE_DAYS * DAY_MS) },
    });
    host.leave(userId, undefined, false);
    return { ok: true, id };
  }

  /** What a link preview may show: the room, never the hider (section 13). */
  async publicInfo(id: string) {
    const p = await this.prisma.camoPuzzle.findUnique({ where: { id }, select: { id: true, kind: true, roomId: true, morphId: true, attempts: true, found: true, expiresAt: true, creatorId: true } });
    if (!p || (p.expiresAt && p.expiresAt < new Date())) return null;
    const creator = p.creatorId ? await this.prisma.user.findUnique({ where: { id: p.creatorId }, select: { name: true } }) : null;
    return { id: p.id, kind: p.kind, roomId: p.roomId, creatorName: creator?.name ?? null, attempts: p.attempts, found: p.found };
  }

  /** Starts the 60 s puzzle for a seeker; daily puzzles allow one attempt per person per day. */
  async start(host: CamoHost, u: CamoUser, id: string): Promise<JoinResult | { ok: false; reason: 'played' | 'expired' | 'unknown_code' }> {
    const p = await this.prisma.camoPuzzle.findUnique({ where: { id } });
    if (!p || (p.expiresAt && p.expiresAt < new Date())) return { ok: false, reason: p ? 'expired' : 'unknown_code' };
    if (p.kind === 'daily' && (await this.prisma.camoPuzzleAttempt.count({ where: { puzzleId: id, userId: u.userId } }))) return { ok: false, reason: 'played' };
    const strokes = decodeStrokes(new Uint8Array(p.strokes), 1500) ?? [];
    const creator = p.creatorId ? await this.prisma.user.findUnique({ where: { id: p.creatorId }, select: { name: true } }) : null;
    return host.startPuzzle(u, { puzzleId: p.id, roomId: p.roomId, x: p.x, z: p.z, yaw: p.yaw, pose: p.pose as never, strokes, morphId: p.morphId, creatorName: creator?.name ?? (p.kind === 'daily' ? '🦎' : '?') });
  }

  /** A puzzle match ended: store the attempt, the puzzle's counters and the daily streak. */
  async finished(m: CamoMatch): Promise<void> {
    const pz = m.puzzle;
    const human = m.players.find((x) => !x.isBot);
    if (!pz || !human) return;
    const success = pz.foundMs !== null;
    try {
      await this.prisma.camoPuzzleAttempt.create({ data: { puzzleId: pz.puzzleId, userId: human.userId, deviceId: human.deviceId, success, foundMs: pz.foundMs, tags: pz.misses + (success ? 1 : 0) } });
      await this.prisma.camoPuzzle.update({ where: { id: pz.puzzleId }, data: { attempts: { increment: 1 }, ...(success ? { found: { increment: 1 } } : {}) } });
      const puzzle = await this.prisma.camoPuzzle.findUnique({ where: { id: pz.puzzleId }, select: { kind: true, dayKey: true, creatorId: true } });
      if (puzzle?.kind === 'daily' && human.userId && puzzle.dayKey) await this.bumpStreak(human.userId, puzzle.dayKey);
    } catch (err) {
      this.logger.warn(`puzzle attempt not stored: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async bumpStreak(userId: string, day: string): Promise<void> {
    const stats = await this.prisma.camoStats.findUnique({ where: { userId }, select: { dailyStreak: true, lastDailyDay: true } });
    const yesterday = cairoDay(Date.parse(`${day}T12:00:00Z`) - DAY_MS);
    const streak = stats?.lastDailyDay === yesterday ? (stats.dailyStreak ?? 0) + 1 : 1;
    await this.prisma.camoStats.upsert({ where: { userId }, create: { userId, dailyStreak: streak, lastDailyDay: day }, update: { dailyStreak: streak, lastDailyDay: day } });
  }

  /** A creator's board: how many found it, and in what time. */
  async mine(userId: string) {
    const rows = await this.prisma.camoPuzzle.findMany({ where: { creatorId: userId, kind: 'challenge' }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, roomId: true, attempts: true, found: true, createdAt: true, expiresAt: true } });
    return rows.map((r) => ({ ...r, missed: r.attempts - r.found }));
  }

  // ── the daily Chameleon ───────────────────────────────────────────────────

  /** Today's puzzle: the admin's pick if any, else a hard bot-made one (same for everyone, made once per Cairo day). */
  async today(host: CamoHost, day = cairoDay()): Promise<{ id: string; day: string; roomId: string; source: string }> {
    const hit = await this.prisma.camoPuzzle.findUnique({ where: { dayKey: day }, select: { id: true, roomId: true, source: true } });
    if (hit) return { ...hit, day };
    const rooms = (this.settings.current.enabledRooms ?? ['locker_room']).filter((r) => host.roomData(r));
    const rng = seeded(`daily:${day}`);
    const roomId = rooms[Math.floor(rng() * rooms.length)] ?? 'locker_room';
    const room = host.roomData(roomId)!;
    const hard = room.hideSpots.filter((s) => s.difficulty === 3);
    const pool = hard.length ? hard : room.hideSpots;
    const spot = pool[Math.floor(rng() * pool.length)];
    const strokes = this.botStrokes(spot.color, rng);
    const id = `d${day.replace(/-/g, '')}`;
    try {
      await this.prisma.camoPuzzle.create({ data: { id, kind: 'daily', dayKey: day, roomId, x: spot.x, z: spot.z, yaw: Math.atan2(spot.nx, spot.nz), pose: spot.poses[0] ?? 'stand', morphId: 'classic', strokes: Buffer.from(encodeStrokes(strokes)), source: 'bot' } });
    } catch {
      // another instance made it first
    }
    const made = await this.prisma.camoPuzzle.findUnique({ where: { dayKey: day }, select: { id: true, roomId: true, source: true } });
    return { ...(made ?? { id, roomId, source: 'bot' }), day };
  }

  private botStrokes(color: number, rng: () => number): WireStroke[] {
    const jitter = (v: number, e: number): number => Math.max(0, Math.min(255, Math.round(v + (rng() - 0.5) * e)));
    const rgb = (k: number): number => (jitter(((color >> 16) & 255) + k, 20) << 16) | (jitter(((color >> 8) & 255) + k, 20) << 8) | jitter((color & 255) + k, 20);
    const out: WireStroke[] = [{ kind: 'fill', x: 0, y: 0, z: 0, r: 1, rgb: rgb(0), rough: 200, hard: 255, nx: 0, ny: 0, nz: 0, seed: 0 }];
    for (let i = 0; i < 10; i++) out.push({ kind: 'spray', x: Math.round((rng() - 0.5) * 400), y: 200 + Math.floor(rng() * 1200), z: Math.round((rng() - 0.5) * 300), r: 60, rgb: rgb((rng() - 0.5) * 30), rough: 190, hard: 120, nx: 0, ny: 0, nz: 0, seed: Math.floor(rng() * 65535) });
    return out;
  }

  /** Admin: set (or replace) the day's puzzle from a challenge someone made. */
  async setDaily(day: string, fromPuzzleId: string): Promise<boolean> {
    const src = await this.prisma.camoPuzzle.findUnique({ where: { id: fromPuzzleId } });
    if (!src) return false;
    await this.prisma.camoPuzzle.deleteMany({ where: { dayKey: day, source: 'bot' } });
    const id = `d${day.replace(/-/g, '')}`;
    await this.prisma.camoPuzzle.upsert({
      where: { id },
      update: { roomId: src.roomId, x: src.x, z: src.z, yaw: src.yaw, pose: src.pose, morphId: src.morphId, strokes: src.strokes, source: 'admin' },
      create: { id, kind: 'daily', dayKey: day, roomId: src.roomId, x: src.x, z: src.z, yaw: src.yaw, pose: src.pose, morphId: src.morphId, strokes: src.strokes, source: 'admin' },
    });
    return true;
  }

  /** Fastest finders of a day (names, times): the daily board. */
  async board(day: string, take = 20) {
    const p = await this.prisma.camoPuzzle.findUnique({ where: { dayKey: day }, select: { id: true } });
    if (!p) return [];
    const rows = await this.prisma.camoPuzzleAttempt.findMany({ where: { puzzleId: p.id, success: true }, orderBy: { foundMs: 'asc' }, take, select: { foundMs: true, userId: true } });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const name = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r, i) => ({ rank: i + 1, name: r.userId ? name.get(r.userId) ?? '?' : '?', foundMs: r.foundMs }));
  }

  /** Daily cleanup: expired challenges and their attempts. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweep(): Promise<number> {
    const gone = await this.prisma.camoPuzzle.findMany({ where: { kind: 'challenge', expiresAt: { lt: new Date() } }, select: { id: true }, take: 500 });
    if (!gone.length) return 0;
    const ids = gone.map((g) => g.id);
    await this.prisma.camoPuzzleAttempt.deleteMany({ where: { puzzleId: { in: ids } } });
    await this.prisma.camoPuzzle.deleteMany({ where: { id: { in: ids } } });
    return ids.length;
  }
}
