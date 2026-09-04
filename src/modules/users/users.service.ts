import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateAvatarConfigDto } from './dto/update-avatar-config.dto';
import { buildPagination } from '../../common/dto/page-query.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { sportSkills: { include: { sport: true } }, badges: { include: { badge: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    return this.sanitize(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: dto });
    return this.sanitize(user);
  }

  async updateAvatarUrl(userId: string, avatarUrl: string) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
    return this.sanitize(user);
  }

  async updateAvatarConfig(userId: string, dto: UpdateAvatarConfigDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarConfig: dto as unknown as Prisma.InputJsonValue },
    });
    return this.sanitize(user);
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

    const [matchesPlayed, mvpCount] = await Promise.all([
      this.prisma.playerRating.count({ where: { rateeId: userId } }),
      this.prisma.playerRating.count({ where: { rateeId: userId, mvpVote: true } }),
    ]);

    return {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      avatarConfig: user.avatarConfig,
      reputation: user.reputation,
      reliabilityPct: user.reliabilityPct,
      sports: user.sportSkills.map((s) => ({
        sportId: s.sportId,
        nameEn: s.sport.nameEn,
        nameAr: s.sport.nameAr,
        tier: s.tier,
        position: s.position,
      })),
      badges: user.badges.map((b) => b.badge),
      teams: user.teamMemberships.map((m) => m.team),
      stats: { matchesPlayed, mvpCount },
    };
  }

  async list(query: { page: number; perPage: number; search?: string; role?: string; status?: string }) {
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
      ...(query.role ? { roles: { has: query.role as any } } : {}),
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
    const user = await this.prisma.user.update({ where: { id: userId }, data: { status } });
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
