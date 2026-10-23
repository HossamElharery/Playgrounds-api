import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AchievementsService } from './achievements.service';

export type CompetitiveGame = 'penalties' | 'thief' | 'camo';

export interface GameResult {
  game: CompetitiveGame;
  /** Everyone who played the game to its end (bots and guests may be in here). */
  participants: readonly string[];
  /** Players who won. Empty or everyone = a draw. */
  winners: readonly string[];
}

/**
 * Turns the end of a lobby game into achievement progress. Only games played
 * against at least one other real (registered, active) player count, so a
 * game with bots, guests or a lone player never moves a counter.
 */
@Injectable()
export class GameResultsService {
  private readonly logger = new Logger(GameResultsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly achievements: AchievementsService,
  ) {}

  async record(result: GameResult): Promise<void> {
    try {
      const ids = [...new Set(result.participants)];
      if (ids.length < 2) return;
      const humans = new Set(
        (
          await this.prisma.user.findMany({
            where: { id: { in: ids }, isGuest: false, status: 'active', deletedAt: null },
            select: { id: true },
          })
        ).map((u) => u.id),
      );
      if (humans.size < 2) return;
      const winners = result.winners.filter((id) => humans.has(id));
      const draw = winners.length === 0 || winners.length >= humans.size;
      for (const id of humans) {
        await this.achievements.bump(id, 'game.played');
        if (!draw && winners.includes(id)) {
          await this.achievements.bump(id, `game.win.${result.game}`);
          await this.achievements.bump(id, 'game.win');
        }
      }
    } catch (err) {
      this.logger.warn(`game result not recorded: ${err instanceof Error ? err.message : err}`);
    }
  }
}
