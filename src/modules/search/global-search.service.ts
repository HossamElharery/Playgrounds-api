import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { GlobalSearchDto } from './dto/global-search.dto';
import type { GlobalSearchResult } from './global-search.types';

const DEFAULT_LIMIT = 5;

/**
 * One round-trip for the in-app command palette. Each source is a tight
 * `contains` query with a small `take` — never a full table scan, never AI.
 */
@Injectable()
export class GlobalSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(dto: GlobalSearchDto): Promise<GlobalSearchResult> {
    const q = dto.q.trim();
    const take = dto.limit ?? DEFAULT_LIMIT;
    if (!q) {
      return {
        venues: [],
        players: [],
        teams: [],
        matches: [],
        tournaments: [],
      };
    }

    const [venues, players, teams, matches, tournaments] = await Promise.all([
      this.venues(q, take),
      this.players(q, take),
      this.teams(q, take),
      this.matches(q, take),
      this.tournaments(q, take),
    ]);

    return { venues, players, teams, matches, tournaments };
  }

  private async venues(
    q: string,
    take: number,
  ): Promise<GlobalSearchResult['venues']> {
    const rows = await this.prisma.venue.findMany({
      where: {
        status: 'active',
        isDemo: false,
        OR: [
          { nameEn: { contains: q, mode: 'insensitive' } },
          { nameAr: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: [{ featured: 'desc' }, { ratingAvg: 'desc' }],
      take,
      select: {
        id: true,
        slug: true,
        nameAr: true,
        nameEn: true,
        ratingAvg: true,
        instantBook: true,
        district: { select: { nameAr: true, nameEn: true } },
        photos: {
          orderBy: { position: 'asc' },
          take: 1,
          select: { url: true },
        },
      },
    });
    return rows.map((v) => ({
      kind: 'venue' as const,
      id: v.id,
      slug: v.slug,
      nameAr: v.nameAr,
      nameEn: v.nameEn,
      districtAr: v.district?.nameAr ?? null,
      districtEn: v.district?.nameEn ?? null,
      photo: v.photos[0]?.url ?? null,
      ratingAvg: v.ratingAvg,
      instantBook: v.instantBook,
    }));
  }

  private async players(
    q: string,
    take: number,
  ): Promise<GlobalSearchResult['players']> {
    const rows = await this.prisma.user.findMany({
      where: {
        status: 'active',
        roles: { has: 'player' },
        isGuest: false,
        name: { contains: q, mode: 'insensitive' },
      },
      orderBy: [{ reputation: 'desc' }, { matchesPlayed: 'desc' }],
      take,
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        reputation: true,
        matchesPlayed: true,
      },
    });
    return rows.map((u) => ({
      kind: 'player' as const,
      id: u.id,
      name: u.name,
      avatarUrl: u.avatarUrl,
      reputation: u.reputation,
      matchesPlayed: u.matchesPlayed,
    }));
  }

  private async teams(
    q: string,
    take: number,
  ): Promise<GlobalSearchResult['teams']> {
    const rows = await this.prisma.team.findMany({
      where: {
        archivedAt: null,
        name: { contains: q, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        name: true,
        logoUrl: true,
        sport: { select: { nameAr: true, nameEn: true } },
        _count: { select: { members: true } },
      },
    });
    return rows.map((t) => ({
      kind: 'team' as const,
      id: t.id,
      name: t.name,
      logoUrl: t.logoUrl,
      sportAr: t.sport?.nameAr ?? null,
      sportEn: t.sport?.nameEn ?? null,
      memberCount: t._count.members,
    }));
  }

  private async matches(
    q: string,
    take: number,
  ): Promise<GlobalSearchResult['matches']> {
    const rows = await this.prisma.matchPost.findMany({
      where: {
        status: { in: ['open', 'full'] },
        dateTime: { gte: new Date() },
        OR: [
          { notes: { contains: q, mode: 'insensitive' } },
          { sport: { nameEn: { contains: q, mode: 'insensitive' } } },
          { sport: { nameAr: { contains: q, mode: 'insensitive' } } },
          { district: { nameEn: { contains: q, mode: 'insensitive' } } },
          { district: { nameAr: { contains: q, mode: 'insensitive' } } },
        ],
      },
      orderBy: { dateTime: 'asc' },
      take,
      select: {
        id: true,
        notes: true,
        dateTime: true,
        status: true,
        playersNeeded: true,
        sport: { select: { nameAr: true, nameEn: true } },
        district: { select: { nameAr: true, nameEn: true } },
      },
    });
    return rows.map((m) => ({
      kind: 'match' as const,
      id: m.id,
      notes: m.notes,
      sportAr: m.sport.nameAr,
      sportEn: m.sport.nameEn,
      districtAr: m.district?.nameAr ?? null,
      districtEn: m.district?.nameEn ?? null,
      dateTime: m.dateTime.toISOString(),
      status: m.status,
      playersNeeded: m.playersNeeded,
    }));
  }

  private async tournaments(
    q: string,
    take: number,
  ): Promise<GlobalSearchResult['tournaments']> {
    const rows = await this.prisma.tournament.findMany({
      where: {
        status: { in: ['open', 'full', 'in-progress'] },
        OR: [
          { nameEn: { contains: q, mode: 'insensitive' } },
          { nameAr: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: { startsAt: 'asc' },
      take,
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        status: true,
        startsAt: true,
      },
    });
    return rows.map((t) => ({
      kind: 'tournament' as const,
      id: t.id,
      nameAr: t.nameAr,
      nameEn: t.nameEn,
      status: t.status,
      startsAt: t.startsAt.toISOString(),
    }));
  }
}
