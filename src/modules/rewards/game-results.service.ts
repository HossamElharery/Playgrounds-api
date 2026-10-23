import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AchievementsService } from './achievements.service';
import { DeviceLinksService } from './risk/device-links.service';

export type CompetitiveGame = 'penalties' | 'thief' | 'camo';

export interface GameResult {
  game: CompetitiveGame;
  /** Everyone who played the game to its end (bots and guests may be in here). */
  participants: readonly string[];
  /** Players who won. Empty or everyone = a draw. */
  winners: readonly string[];
}

/**
 * Turns the end of a lobby game into achievement progress. A game counts for
 * a player only against at least one other *trusted* real player who is not
 * on the same device, and any one pair of players can add only a few wins
 * (and plays) to each other, ever. Bots, guests, brand-new accounts and your
 * own second account never move a counter.
 */
@Injectable()
export class GameResultsService {
  private readonly logger = new Logger(GameResultsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly achievements: AchievementsService,
    private readonly links: DeviceLinksService,
  ) {}

  async record(result: GameResult): Promise<void> {
    try {
      const ids = [...new Set(result.participants)];
      if (ids.length < 2) return;
      const humans = await this.prisma.user.findMany({
        where: {
          id: { in: ids },
          isGuest: false,
          status: 'active',
          deletedAt: null,
          rewardsBlockedAt: null,
        },
        select: { id: true, trustedAt: true },
      });
      if (humans.length < 2) return;
      const trusted = new Set(humans.filter((h) => h.trustedAt).map((h) => h.id));
      const humanIds = humans.map((h) => h.id);
      const winners = new Set(result.winners.filter((id) => humanIds.includes(id)));
      const draw = winners.size === 0 || winners.size >= humanIds.length;
      for (const id of humanIds) {
        const linked = await this.links.linkedIds(id);
        const opponents = humanIds.filter((o) => o !== id && trusted.has(o) && !linked.has(o));
        if (!opponents.length) continue;
        let countedPlay = false;
        for (const o of opponents) {
          if ((await this.achievements.bump(id, `pair.play:${o}`)) > 0) countedPlay = true;
        }
        if (countedPlay) await this.achievements.bump(id, 'game.played');
        if (draw || !winners.has(id)) continue;
        let countedWin = false;
        for (const o of opponents) {
          if ((await this.achievements.bump(id, `pair.win:${o}`)) > 0) {
            countedWin = true;
            break;
          }
        }
        if (!countedWin) continue;
        await this.achievements.bump(id, `game.win.${result.game}`);
        await this.achievements.bump(id, 'game.win');
      }
    } catch (err) {
      this.logger.warn(`game result not recorded: ${err instanceof Error ? err.message : err}`);
    }
  }
}
