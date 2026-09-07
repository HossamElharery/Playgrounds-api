import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateAvatarConfigDto } from './dto/update-avatar-config.dto';
import { buildPagination } from '../../common/dto/page-query.dto';
import { computeXp, playerLevel } from '../../common/utils/player-level.util';
import { UpdatePrivacyDto } from './dto/block-user.dto';
import { ListPlayersQueryDto } from './dto/list-players-query.dto';
import { normalizeCountryCode } from '../../common/geo/country.util';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        sportSkills: { include: { sport: true } },
        badges: { include: { badge: true } },
        favoriteVenues: { select: { venueId: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return this.sanitize(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const countryCode = dto.countryCode
      ? normalizeCountryCode(dto.countryCode)
      : undefined;
    if (dto.countryCode && !countryCode) {
      throw new BadRequestException('Invalid country code');
    }
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name,
        preferredLang: dto.preferredLang,
        bioEn: dto.bioEn,
        bioAr: dto.bioAr,
        ...(countryCode ? { countryCode } : {}),
      },
    });
    return this.sanitize(user);
  }

  async updatePrivacy(userId: string, dto: UpdatePrivacyDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: dto,
    });
    return this.sanitize(user);
  }

  async updateAvatarUrl(userId: string, avatarUrl: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
    });
    return this.sanitize(user);
  }

  async updateAvatarConfig(userId: string, dto: UpdateAvatarConfigDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarConfig: dto as unknown as Prisma.InputJsonValue },
    });
    return this.sanitize(user);
  }

  private toPublic(user: {
    id: string;
    name: string;
    avatarUrl: string | null;
    avatarConfig: unknown;
    bioEn: string | null;
    bioAr: string | null;
    reputation: number;
    reliabilityPct: number;
    matchesPlayed: number;
    mvps: number;
    streakCount: number;
    sportSkills: {
      sportId: string;
      tier: string;
      position: string | null;
      eloScore: number;
      sport: { nameEn: string; nameAr: string };
    }[];
    badges: { badge: unknown }[];
    teamMemberships?: { team: unknown }[];
  }) {
    const avgElo =
      user.sportSkills.length === 0
        ? 1000
        : user.sportSkills.reduce((s, x) => s + x.eloScore, 0) /
          user.sportSkills.length;
    const xp = computeXp({
      matchesPlayed: user.matchesPlayed,
      mvps: user.mvps,
      reputation: user.reputation,
      reliabilityPct: user.reliabilityPct,
      streakCount: user.streakCount,
      badgeCount: user.badges.length,
      avgElo,
    });
    const lvl = playerLevel(xp);
    return {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      avatarConfig: user.avatarConfig,
      bio: { en: user.bioEn, ar: user.bioAr },
      reputation: user.reputation,
      reliabilityPct: user.reliabilityPct,
      matchesPlayed: user.matchesPlayed,
      mvps: user.mvps,
      streak: user.streakCount,
      sports: user.sportSkills.map((s) => ({
        sportId: s.sportId,
        nameEn: s.sport.nameEn,
        nameAr: s.sport.nameAr,
        tier: s.tier,
        position: s.position,
        elo: s.eloScore,
      })),
      badges: user.badges.map((b) => b.badge),
      teams: user.teamMemberships?.map((m) => m.team) ?? [],
      level: lvl.level,
      xp: lvl.xp,
    };
  }

  async publicProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        sportSkills: { include: { sport: true } },
        badges: { include: { badge: true } },
        teamMemberships: { include: { team: true } },
      },
    });
    if (!user) throw new NotFoundException('Player not found');
    return this.toPublic(user);
  }

  async listPlayers(query: ListPlayersQueryDto) {
    const where: Prisma.UserWhereInput = {
      status: 'active',
      roles: { has: 'player' },
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {}),
      ...(query.sportId
        ? {
            sportSkills: {
              some: {
                sport: {
                  OR: [
                    { id: query.sportId },
                    { slug: query.sportId },
                    { id: `sport-${query.sportId}` },
                  ],
                },
              },
            },
          }
        : {}),
    };
    const users = await this.prisma.user.findMany({
      where,
      include: {
        sportSkills: { include: { sport: true } },
        badges: { include: { badge: true } },
      },
      take: 200,
    });
    let rows = users.map((u) => this.toPublic(u));
    const sort = query.sort ?? 'level';
    rows = [...rows].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'reputation') return b.reputation - a.reputation;
      if (sort === 'matches') return b.matchesPlayed - a.matchesPlayed;
      return b.xp - a.xp;
    });
    const limit = query.limit ?? 30;
    const start = query.cursor
      ? rows.findIndex((r) => r.id === query.cursor) + 1
      : 0;
    const slice = rows.slice(
      Math.max(0, start),
      Math.max(0, start) + limit + 1,
    );
    const hasMore = slice.length > limit;
    const page = hasMore ? slice.slice(0, limit) : slice;
    return {
      items: page,
      nextCursor: hasMore ? page.at(-1)?.id : undefined,
    };
  }

  async block(blockerId: string, blockedId: string) {
    if (blockerId === blockedId)
      throw new NotFoundException('Cannot block yourself');
    await this.prisma.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      update: {},
      create: { blockerId, blockedId },
    });
    await this.prisma.friendship.deleteMany({
      where: {
        OR: [
          { requesterId: blockerId, addresseeId: blockedId },
          { requesterId: blockedId, addresseeId: blockerId },
        ],
      },
    });
  }

  async unblock(blockerId: string, blockedId: string) {
    await this.prisma.userBlock.deleteMany({
      where: { blockerId, blockedId },
    });
  }

  listBlocks(userId: string) {
    return this.prisma.userBlock.findMany({
      where: { blockerId: userId },
      include: {
        blocked: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  listFavorites(userId: string) {
    return this.prisma.favoriteVenue.findMany({
      where: { userId },
      include: { venue: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async list(query: {
    page: number;
    perPage: number;
    search?: string;
    role?: string;
    status?: string;
  }) {
    const where: Prisma.UserWhereInput = {
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.role ? { roles: { has: query.role as never } } : {}),
      ...(query.status ? { status: query.status as UserStatus } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: items.map((u) => this.sanitize(u)),
      pagination: buildPagination(query.page, query.perPage, total),
    };
  }

  async updateStatus(userId: string, status: UserStatus) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { status },
    });
    if (status !== 'active') {
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return this.sanitize(user);
  }

  private sanitize<T extends { passwordHash?: string | null }>(user: T) {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
  }
}
