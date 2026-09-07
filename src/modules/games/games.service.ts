import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateGameCatalogEntryDto,
  UpdateGameCatalogEntryDto,
} from './dto/game-catalog.dto';

/**
 * The game library (§3.6/§7.3) — CMS-managed content (admin add/edit/retire),
 * never user-generated. Used by MatchPost.gameId and per-game skill tiers.
 */
@Injectable()
export class GamesService {
  constructor(private readonly prisma: PrismaService) {}

  list(includeInactive = false) {
    return this.prisma.gameCatalogEntry.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: { nameEn: 'asc' },
    });
  }

  async get(id: string) {
    const game = await this.prisma.gameCatalogEntry.findFirst({
      where: { OR: [{ id }, { slug: id }] },
    });
    if (!game) throw new NotFoundException('Game not found');
    return game;
  }

  create(dto: CreateGameCatalogEntryDto) {
    return this.prisma.gameCatalogEntry.create({
      data: {
        slug: dto.slug,
        nameEn: dto.nameEn,
        nameAr: dto.nameAr,
        iconUrl: dto.iconUrl,
        genre: dto.genre,
        supportsCompetitiveTier: dto.supportsCompetitiveTier ?? true,
        ageRating: dto.ageRating ?? 'everyone',
      },
    });
  }

  async update(id: string, dto: UpdateGameCatalogEntryDto) {
    await this.get(id);
    return this.prisma.gameCatalogEntry.update({
      where: { id },
      data: dto,
    });
  }

  async retire(id: string) {
    await this.get(id);
    return this.prisma.gameCatalogEntry.update({
      where: { id },
      data: { active: false },
    });
  }
}
