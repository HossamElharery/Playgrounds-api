import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { cairoDay } from './camo-puzzle.service';
import { COSMETICS, MISSIONS, applyMissions, canBuy, coinsFor, equip, levelOf, xpFor, xpForLevel, type CosmeticKind, type CosmeticState, type MatchDelta, type MissionState } from './camo-progress';
import type { CamoPlayer } from './camo-rules';
import { CamoSettingsService } from './camo-settings.service';

/** Stores XP, coins, missions and cosmetics (section 16). Coins ride the platform's existing balance and ledger. */
@Injectable()
export class CamoProgressService {
  private readonly logger = new Logger(CamoProgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CamoSettingsService,
  ) {}

  deltaOf(p: CamoPlayer, won: boolean): MatchDelta {
    const hiderRounds = p.match.roles.filter((r) => r === 'hider').length;
    return { won, survivedRounds: Math.max(0, hiderRounds - p.match.caught), redCards: p.match.cardsGiven, stampsUsed: p.match.stamps, rounds: p.match.roles.length };
  }

  /** One player's reward for a finished match. Never throws: a failed reward must not touch the match. */
  async award(p: CamoPlayer, won: boolean): Promise<void> {
    if (p.isBot || !p.userId) return;
    try {
      const cfg = this.settings.current;
      const delta = this.deltaOf(p, won);
      const day = cairoDay();
      const row = await this.prisma.camoStats.findUnique({ where: { userId: p.userId }, select: { xp: true, coinsToday: true, coinsDay: true, missions: true } });
      const earnedToday = row?.coinsDay === day ? row.coinsToday : 0;
      const missions = applyMissions((row?.missions as unknown as MissionState | null) ?? null, delta, day);
      const coinsMatch = coinsFor(delta, cfg, earnedToday, p.guest);
      const missionCoins = p.guest ? 0 : missions.completed.length * cfg.missionCoins;
      const coins = coinsMatch + missionCoins;
      const xp = (row?.xp ?? 0) + xpFor(delta, cfg);
      await this.prisma.$transaction(async (tx) => {
        await tx.camoStats.update({ where: { userId: p.userId! }, data: { xp, level: levelOf(xp), coinsDay: day, coinsToday: earnedToday + coinsMatch, missions: missions.state as never } });
        if (coins > 0) {
          await tx.user.update({ where: { id: p.userId! }, data: { coinsBalance: { increment: coins } } });
          await tx.coinLedgerEntry.create({ data: { userId: p.userId!, amount: coins, reason: missionCoins ? 'camo_match_and_mission' : 'camo_match' } });
        }
      });
    } catch (err) {
      this.logger.warn(`camo reward failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** What the progress screen shows. */
  async me(userId: string) {
    const [stats, user] = await Promise.all([
      this.prisma.camoStats.findUnique({ where: { userId } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { coinsBalance: true, isGuest: true } }),
    ]);
    const cfg = this.settings.current;
    const day = cairoDay();
    const xp = stats?.xp ?? 0;
    const level = levelOf(xp);
    const ms = (stats?.missions as unknown as MissionState | null) ?? null;
    const today = ms && ms.day === day ? ms : { day, progress: {}, done: [] };
    const cos = (stats?.cosmetics as unknown as CosmeticState | null) ?? { owned: [], equipped: {} };
    return {
      guest: !!user?.isGuest,
      coins: user?.coinsBalance ?? 0,
      coinsToday: stats?.coinsDay === day ? stats.coinsToday : 0,
      coinsDailyCap: cfg.coinsDailyCap,
      xp,
      level,
      xpThisLevel: xp - xpForLevel(level),
      xpForNext: xpForLevel(level + 1) - xpForLevel(level),
      stats: stats ? { matches: stats.matches, wins: stats.wins, caught: stats.caughtCount, cards: stats.cardsGiven, bestSurvivalMs: stats.bestSurvivalMs, streak: stats.streak, dailyStreak: stats.dailyStreak } : null,
      missions: MISSIONS.map((m) => ({ id: m.id, target: m.target, progress: today.progress[m.id] ?? 0, done: today.done.includes(m.id), coins: cfg.missionCoins })),
      cosmetics: COSMETICS.map((c) => ({ ...c, owned: cos.owned.includes(c.id), equipped: cos.equipped[c.kind] === c.id, locked: level < c.minLevel })),
    };
  }

  async buy(userId: string, id: string) {
    const [stats, user] = await Promise.all([this.prisma.camoStats.findUnique({ where: { userId }, select: { xp: true, cosmetics: true } }), this.prisma.user.findUnique({ where: { id: userId }, select: { coinsBalance: true, isGuest: true } })]);
    if (!user) return { ok: false as const, reason: 'unknown' as const };
    const cos = (stats?.cosmetics as unknown as CosmeticState | null) ?? { owned: [], equipped: {} };
    const verdict = canBuy(id, levelOf(stats?.xp ?? 0), user.coinsBalance, cos, user.isGuest);
    if (!verdict.ok) return verdict;
    const next: CosmeticState = { owned: [...cos.owned, id], equipped: cos.equipped };
    await this.prisma.$transaction(async (tx) => {
      // the balance is re-checked inside the transaction so two taps cannot spend the same coins twice
      const spent = await tx.user.updateMany({ where: { id: userId, coinsBalance: { gte: verdict.cost } }, data: { coinsBalance: { decrement: verdict.cost } } });
      if (spent.count !== 1) throw new Error('coins');
      await tx.coinLedgerEntry.create({ data: { userId, amount: -verdict.cost, reason: `camo_cosmetic:${id}` } });
      await tx.camoStats.upsert({ where: { userId }, create: { userId, cosmetics: next as never }, update: { cosmetics: next as never } });
    });
    return { ok: true as const, cost: verdict.cost };
  }

  async equip(userId: string, kind: CosmeticKind, id: string | null) {
    const stats = await this.prisma.camoStats.findUnique({ where: { userId }, select: { cosmetics: true } });
    const cos = (stats?.cosmetics as unknown as CosmeticState | null) ?? { owned: [], equipped: {} };
    const next = equip(id, kind, cos);
    if (!next) return { ok: false as const };
    await this.prisma.camoStats.update({ where: { userId }, data: { cosmetics: next as never } });
    return { ok: true as const };
  }

  /** The look other players see: the equipped name style (and the rest) for a list of users. */
  async looksOf(userIds: string[]): Promise<Record<string, { level: number; equipped: CosmeticState['equipped'] }>> {
    if (!userIds.length) return {};
    const rows = await this.prisma.camoStats.findMany({ where: { userId: { in: userIds } }, select: { userId: true, xp: true, cosmetics: true } });
    return Object.fromEntries(rows.map((r) => [r.userId, { level: levelOf(r.xp), equipped: ((r.cosmetics as unknown as CosmeticState | null)?.equipped ?? {}) }]));
  }

  /** The leaderboard of the stats screen: most wins, with names. */
  async board(take = 20) {
    const rows = await this.prisma.camoStats.findMany({ orderBy: [{ wins: 'desc' }, { xp: 'desc' }], take, select: { userId: true, wins: true, matches: true, xp: true, user: { select: { name: true, isGuest: true } } } });
    return rows.filter((r) => !r.user.isGuest).map((r, i) => ({ rank: i + 1, name: r.user.name, wins: r.wins, matches: r.matches, level: levelOf(r.xp) }));
  }
}
