import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminReviewDto,
  AdminUserDto,
  AdminVenueDto,
  CoinAdjustmentDto,
  ManagementQuery,
} from './dto/management.dto';
import { encode as encodeGeohash } from 'ngeohash';
import { paginateByCursor } from '../../common/pagination/cursor-pagination.dto';

const userSelect = {
  id: true,
  name: true,
  phone: true,
  email: true,
  username: true,
  avatarUrl: true,
  roles: true,
  status: true,
  preferredLang: true,
  countryCode: true,
  governorateId: true,
  districtId: true,
  locationLat: true,
  locationLng: true,
  locationUpdatedAt: true,
  governorate: { select: { id: true, nameEn: true, nameAr: true } },
  district: { select: { id: true, nameEn: true, nameAr: true } },
  bioAr: true,
  bioEn: true,
  coinsBalance: true,
  reputation: true,
  reliabilityPct: true,
  matchesPlayed: true,
  createdAt: true,
  updatedAt: true,
} as const;
@Injectable()
export class ManagementService {
  constructor(private readonly db: PrismaService) {}
  private page(q: ManagementQuery) {
    return { skip: (q.page - 1) * q.perPage, take: q.perPage };
  }
  private audit(
    tx: Prisma.TransactionClient,
    actor: string,
    type: string,
    id: string,
    reason: string,
    before: unknown,
    changes: unknown,
  ) {
    return tx.auditLogEntry.create({
      data: {
        actorUserId: actor,
        action: `admin.${type}.update`,
        targetType: type,
        targetId: id,
        metadata: JSON.parse(JSON.stringify({ reason, before, changes })),
      },
    });
  }
  async users(q: ManagementQuery) {
    if (q.status && !['active', 'suspended', 'banned'].includes(q.status))
      throw new BadRequestException('Invalid status');
    const where: Prisma.UserWhereInput = {
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.role ? { roles: { has: q.role } } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { phone: { contains: q.search } },
              { email: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.db.user.findMany({
        where,
        select: userSelect,
        ...this.page(q),
        orderBy: { createdAt: 'desc' },
      }),
      this.db.user.count({ where }),
    ]);
    return {
      items,
      total,
      page: q.page,
      totalPages: Math.max(1, Math.ceil(total / q.perPage)),
    };
  }
  async user(id: string) {
    const user = await this.db.user.findUnique({
      where: { id },
      select: {
        ...userSelect,
        ownedVenues: {
          select: {
            id: true,
            slug: true,
            nameAr: true,
            nameEn: true,
            status: true,
          },
        },
        bookings: {
          take: 20,
          orderBy: { createdAt: 'desc' },
          include: {
            venue: { select: { id: true, nameAr: true, nameEn: true } },
            court: { select: { name: true } },
          },
        },
        coinLedger: { take: 20, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
  /**
   * Oversight for the project owner: every "schedule assistant" chat line
   * across every venue this owner runs, newest first, so admin can spot an
   * owner confusing the AI or asking it for things the platform can't do.
   */
  assistantMessages(ownerId: string, limit = 30, cursor?: string) {
    return paginateByCursor(
      (args) =>
        this.db.assistantMessage.findMany({
          where: { ownerId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: { venue: { select: { nameAr: true, nameEn: true } } },
          ...args,
        }),
      limit,
      cursor,
    );
  }
  async updateUser(actor: string, id: string, dto: AdminUserDto) {
    const { reason, ...data } = dto;
    if (data.avatarUrl && !/^(https?:\/\/|\/uploads\/)/i.test(data.avatarUrl))
      throw new BadRequestException('Invalid avatar URL');
    try {
      return await this.db.$transaction(
        async (tx) => {
          const before = await tx.user.findUnique({
            where: { id },
            select: userSelect,
          });
          if (!before) throw new NotFoundException('User not found');
          if (data.districtId) {
            const district = await tx.district.findUnique({
              where: { id: data.districtId },
              select: { governorateId: true },
            });
            if (!district) throw new BadRequestException('District not found');
            data.governorateId = district.governorateId;
          } else if (data.governorateId) {
            const governorate = await tx.governorate.findUnique({
              where: { id: data.governorateId },
              select: { id: true },
            });
            if (!governorate) throw new BadRequestException('Governorate not found');
          }
          const removesAdmin =
            (data.roles && !data.roles.includes('admin')) ||
            (data.status && data.status !== 'active');
          if (before.roles.includes('admin') && removesAdmin) {
            if (id === actor)
              throw new BadRequestException(
                'You cannot remove your own administrator access',
              );
            if (
              (await tx.user.count({
                where: { roles: { has: 'admin' }, status: 'active' },
              })) <= 1
            )
              throw new BadRequestException(
                'The last active administrator must remain',
              );
          }
          const updated = await tx.user.update({
            where: { id },
            data,
            select: userSelect,
          });
          if (data.status || data.roles || data.phone || data.email)
            await tx.refreshToken.updateMany({
              where: { userId: id, revokedAt: null },
              data: { revokedAt: new Date() },
            });
          await this.audit(tx, actor, 'user', id, reason, before, data);
          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw new ConflictException('Phone, email or username already in use');
      throw e;
    }
  }
  async coins(actor: string, id: string, dto: CoinAdjustmentDto) {
    if (!dto.amount)
      throw new BadRequestException('Adjustment must not be zero');
    return this.db.$transaction(async (tx) => {
      const result = await tx.user.updateMany({
        where: {
          id,
          ...(dto.amount < 0 ? { coinsBalance: { gte: -dto.amount } } : {}),
        },
        data: { coinsBalance: { increment: dto.amount } },
      });
      if (!result.count)
        throw new BadRequestException('User not found or insufficient coins');
      await tx.coinLedgerEntry.create({
        data: {
          userId: id,
          amount: dto.amount,
          reason: `admin: ${dto.reason}`,
        },
      });
      await this.audit(tx, actor, 'coins', id, dto.reason, null, {
        amount: dto.amount,
      });
      return tx.user.findUnique({ where: { id }, select: userSelect });
    });
  }
  async venues(q: ManagementQuery) {
    if (q.status && !['pending', 'active', 'suspended'].includes(q.status))
      throw new BadRequestException('Invalid status');
    const where: Prisma.VenueWhereInput = {
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.search
        ? {
            OR: [
              { nameEn: { contains: q.search, mode: 'insensitive' } },
              { nameAr: { contains: q.search } },
              { slug: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.db.venue.findMany({
        where,
        include: {
          owner: { select: { id: true, name: true } },
          _count: { select: { courts: true, bookings: true } },
        },
        ...this.page(q),
        orderBy: { createdAt: 'desc' },
      }),
      this.db.venue.count({ where }),
    ]);
    return {
      items,
      total,
      page: q.page,
      totalPages: Math.max(1, Math.ceil(total / q.perPage)),
    };
  }
  async venue(id: string) {
    const v = await this.db.venue.findFirst({
      where: { OR: [{ id }, { slug: id }] },
      include: {
        owner: { select: { id: true, name: true, phone: true } },
        courts: { include: { pricingRules: true, sport: true } },
        photos: { orderBy: { position: 'asc' } },
        amenities: { include: { amenity: true } },
        sports: { include: { sport: true } },
        governorate: true,
        district: true,
        reviews: {
          take: 50,
          orderBy: { createdAt: 'desc' },
          include: { user: { select: { id: true, name: true } } },
        },
      },
    });
    if (!v) throw new NotFoundException('Venue not found');
    return v;
  }
  async updateVenue(actor: string, id: string, dto: AdminVenueDto) {
    const { reason: rawReason, sportIds, amenityKeys, ...data } = dto;
    const reason = rawReason?.trim() || 'Admin edit';
    return this.db.$transaction(async (tx) => {
      const before = await tx.venue.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Venue not found');
      const countryCode = data.countryCode ?? before.countryCode;
      const governorateId = data.governorateId ?? before.governorateId;
      const districtId = data.districtId ?? before.districtId;
      if (!/^[A-Z]{2}$/.test(countryCode))
        throw new BadRequestException('Invalid country code');
      if (governorateId) {
        const governorate = await tx.governorate.findUnique({
          where: { id: governorateId },
        });
        if (!governorate || governorate.countryCode !== countryCode)
          throw new BadRequestException('Governorate and country must match');
      }
      if (districtId) {
        const district = await tx.district.findUnique({
          where: { id: districtId },
        });
        if (!district || district.governorateId !== governorateId)
          throw new BadRequestException('District and governorate must match');
      }
      if (sportIds) {
        const uniqueIds = [...new Set(sportIds)];
        if (
          (await tx.sportCategory.count({ where: { id: { in: uniqueIds } } })) !==
          uniqueIds.length
        )
          throw new BadRequestException('Unknown sport');
        if (
          await tx.court.count({
            where: { venueId: id, sportId: { notIn: uniqueIds } },
          })
        )
          throw new BadRequestException(
            'Cannot remove an activity used by an existing court or room',
          );
      }
      if (data.ownerId) {
        const owner = await tx.user.findUnique({
          where: { id: data.ownerId },
          select: { roles: true, status: true },
        });
        if (
          !owner ||
          owner.status !== 'active' ||
          !owner.roles.some((r) => r === 'owner' || r === 'admin')
        )
          throw new BadRequestException(
            'Select an active owner or administrator',
          );
      }
      if (data.districtId) {
        const d = await tx.district.findUnique({
          where: { id: data.districtId },
          include: { governorate: true },
        });
        if (
          !d ||
          d.governorateId !== (data.governorateId ?? before.governorateId) ||
          d.governorate.countryCode !== (data.countryCode ?? before.countryCode)
        )
          throw new BadRequestException(
            'District, governorate and country must match',
          );
      }
      const updated = await tx.venue.update({
        where: { id },
        data: {
          ...data,
          ...(data.lat !== undefined || data.lng !== undefined
            ? {
                geohash: encodeGeohash(
                  data.lat ?? before.lat,
                  data.lng ?? before.lng,
                ),
              }
            : {}),
          ...(data.status === 'active'
            ? { approvedById: actor, approvedAt: new Date() }
            : {}),
        },
      });
      if (sportIds) {
        await tx.venueSport.deleteMany({ where: { venueId: id } });
        await tx.venueSport.createMany({
          data: [...new Set(sportIds)].map((sportId) => ({
            venueId: id,
            sportId,
          })),
        });
      }
      if (amenityKeys) {
        const amenities = await tx.amenity.findMany({
          where: { key: { in: amenityKeys } },
        });
        if (amenities.length !== new Set(amenityKeys).size)
          throw new BadRequestException('Unknown amenity');
        await tx.venueAmenity.deleteMany({ where: { venueId: id } });
        await tx.venueAmenity.createMany({
          data: amenities.map((a) => ({ venueId: id, amenityId: a.id })),
        });
      }
      await this.audit(tx, actor, 'venue', id, reason, before, dto);
      return updated;
    });
  }
  async updateReview(actor: string, id: string, dto: AdminReviewDto) {
    const { reason, ...data } = dto;
    return this.db.$transaction(async (tx) => {
      const before = await tx.venueReview.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Review not found');
      const result = await tx.venueReview.update({
        where: { id },
        data: {
          ...data,
          ...(data.ownerReply !== undefined
            ? { ownerRepliedAt: new Date() }
            : {}),
        },
      });
      const agg = await tx.venueReview.aggregate({
        where: { venueId: before.venueId },
        _avg: { stars: true },
        _count: true,
      });
      await tx.venue.update({
        where: { id: before.venueId },
        data: { ratingAvg: agg._avg.stars ?? 0, ratingCount: agg._count },
      });
      await this.audit(tx, actor, 'review', id, reason, before, data);
      return result;
    });
  }
  async bookings(q: ManagementQuery) {
    if (
      q.status &&
      !['held', 'confirmed', 'completed', 'cancelled', 'no_show'].includes(
        q.status,
      )
    )
      throw new BadRequestException('Invalid booking status');
    const where: Prisma.BookingWhereInput = {
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.venueId ? { venueId: q.venueId } : {}),
      ...(q.search
        ? {
            OR: [
              { code: { contains: q.search, mode: 'insensitive' } },
              { user: { name: { contains: q.search, mode: 'insensitive' } } },
              {
                venue: { nameEn: { contains: q.search, mode: 'insensitive' } },
              },
              { venue: { nameAr: { contains: q.search } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.db.booking.findMany({
        where,
        ...this.page(q),
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true } },
          venue: { select: { id: true, nameAr: true, nameEn: true } },
          court: { select: { name: true } },
        },
      }),
      this.db.booking.count({ where }),
    ]);
    return {
      items,
      total,
      page: q.page,
      totalPages: Math.max(1, Math.ceil(total / q.perPage)),
    };
  }
  async booking(id: string) {
    const b = await this.db.booking.findUnique({
      where: { id },
      include: {
        user: { select: userSelect },
        venue: { select: { id: true, nameEn: true, nameAr: true } },
        court: true,
        payments: true,
        splitShares: true,
      },
    });
    if (!b) throw new NotFoundException('Booking not found');
    return b;
  }
}
