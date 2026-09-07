import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReportDto } from './dto/create-report.dto';
import { ResolveReportDto } from './dto/resolve-report.dto';
import { UpsertFeatureFlagDto } from './dto/feature-flag.dto';
import { buildPagination } from '../../common/dto/page-query.dto';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthAgo = new Date(now);
    monthAgo.setDate(monthAgo.getDate() - 30);

    const [
      gmvAgg,
      bookingsToday,
      bookingsWeek,
      activeUsers,
      signupsWeek,
      topVenues,
      matchPostsTotal,
      matchPostsFilled,
    ] = await Promise.all([
      this.prisma.booking.aggregate({
        where: { status: 'completed' },
        _sum: { totalAmount: true },
      }),
      this.prisma.booking.count({ where: { createdAt: { gte: todayStart } } }),
      this.prisma.booking.count({ where: { createdAt: { gte: weekStart } } }),
      this.prisma.user.count({ where: { updatedAt: { gte: monthAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: weekStart } } }),
      this.prisma.venue.findMany({
        orderBy: { bookings: { _count: 'desc' } },
        take: 5,
        select: {
          id: true,
          nameEn: true,
          nameAr: true,
          _count: { select: { bookings: true } },
        },
      }),
      this.prisma.matchPost.count(),
      this.prisma.matchPost.count({
        where: { status: { in: ['full', 'played'] } },
      }),
    ]);

    return {
      gmv: gmvAgg._sum.totalAmount ?? 0,
      bookingsToday,
      bookingsWeek,
      activeUsers,
      signupsWeek,
      topVenues,
      matchPostFillRatePct: matchPostsTotal
        ? Math.round((matchPostsFilled / matchPostsTotal) * 100)
        : 0,
    };
  }

  // ---- Moderation ----
  createReport(reporterId: string, dto: CreateReportDto) {
    return this.prisma.moderationReport.create({
      data: {
        entityType: dto.entityType,
        entityId: dto.entityId,
        reporterId,
        reportedUserId: dto.reportedUserId,
        reason: dto.reason,
      },
    });
  }

  async listReports(page: number, perPage: number, status?: string) {
    const where = status ? { status: status as any } : {};
    const [items, total] = await Promise.all([
      this.prisma.moderationReport.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { createdAt: 'desc' },
        include: {
          reporter: { select: { id: true, name: true } },
          reportedUser: { select: { id: true, name: true } },
        },
      }),
      this.prisma.moderationReport.count({ where }),
    ]);
    return { items, pagination: buildPagination(page, perPage, total) };
  }

  async resolveReport(adminId: string, id: string, dto: ResolveReportDto) {
    const report = await this.prisma.moderationReport.findUnique({
      where: { id },
    });
    if (!report) throw new NotFoundException('Report not found');
    return this.prisma.moderationReport.update({
      where: { id },
      data: {
        status: dto.status,
        resolutionNote: dto.resolutionNote,
        reviewedById: adminId,
      },
    });
  }

  // ---- Audit log ----
  async logAction(
    actorUserId: string,
    action: string,
    targetType?: string,
    targetId?: string,
    metadata?: Record<string, unknown>,
  ) {
    return this.prisma.auditLogEntry.create({
      data: {
        actorUserId,
        action,
        targetType,
        targetId,
        metadata: metadata as any,
      },
    });
  }

  async listAuditLog(page: number, perPage: number) {
    const [items, total] = await Promise.all([
      this.prisma.auditLogEntry.findMany({
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { id: true, name: true } } },
      }),
      this.prisma.auditLogEntry.count(),
    ]);
    return { items, pagination: buildPagination(page, perPage, total) };
  }

  // ---- Feature flags ----
  listFeatureFlags() {
    return this.prisma.featureFlag.findMany();
  }

  upsertFeatureFlag(dto: UpsertFeatureFlagDto) {
    return this.prisma.featureFlag.upsert({
      where: { key: dto.key },
      update: { enabled: dto.enabled, description: dto.description },
      create: dto,
    });
  }

  // ---- Analytics (pragmatic aggregates — see MAL3AB_BACKEND.md for scope) ----
  async searchFunnel() {
    const [venueSearches, venueViews, bookingsCreated, bookingsCompleted] =
      await Promise.all([
        this.prisma.venue.count({ where: { status: 'active' } }), // proxy: searchable inventory
        this.prisma.booking.count(),
        this.prisma.booking.count({
          where: { status: { in: ['confirmed', 'completed'] } },
        }),
        this.prisma.booking.count({ where: { status: 'completed' } }),
      ]);
    return { venueSearches, venueViews, bookingsCreated, bookingsCompleted };
  }

  async cohortRetention() {
    const signupsByWeek = await this.prisma.$queryRaw<
      { week: string; count: bigint }[]
    >`
      SELECT to_char(date_trunc('week', "createdAt"), 'IYYY-IW') as week, count(*)::bigint as count
      FROM "User" GROUP BY 1 ORDER BY 1 DESC LIMIT 12
    `;
    return signupsByWeek.map((r) => ({
      week: r.week,
      signups: Number(r.count),
    }));
  }
}
