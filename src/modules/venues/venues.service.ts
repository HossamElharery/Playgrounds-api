import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, VenueStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { SearchVenuesDto } from './dto/search-venues.dto';
import { CreateCourtDto, UpdateCourtDto } from './dto/court.dto';
import { UpsertPricingRuleDto } from './dto/pricing-rule.dto';
import {
  bboxFromRadiusKm,
  clusterByGeohash,
  encodeGeohash,
  geohashPrefixesForBbox,
  haversineKm,
  toSearchBoundary,
} from '../../common/utils/geo.util';
import { normalizeCountryCode } from '../../common/geo/country.util';
import { zonedWallTimeToUtc } from '../../common/utils/timezone.util';
import { buildPagination } from '../../common/dto/page-query.dto';

@Injectable()
export class VenuesService {
  constructor(private readonly prisma: PrismaService) {}

  private slugify(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-') || 'venue'
    );
  }

  async create(ownerId: string, dto: CreateVenueDto) {
    const governorate = dto.governorateId
      ? await this.prisma.governorate.findUnique({
          where: { id: dto.governorateId },
        })
      : null;
    const countryCode = normalizeCountryCode(
      governorate?.countryCode ?? dto.countryCode,
    );
    if (!countryCode) {
      throw new BadRequestException(
        'countryCode or governorateId is required',
      );
    }
    const country = await this.prisma.countryConfig.findUnique({
      where: { code: countryCode },
    });
    if (!country?.active) {
      throw new BadRequestException('Unknown or inactive country');
    }

    const baseSlug = `${countryCode.toLowerCase()}-${this.slugify(dto.nameEn)}`;
    let slug = baseSlug;
    let suffix = 1;
    while (await this.prisma.venue.findUnique({ where: { slug } })) {
      slug = `${baseSlug}-${++suffix}`;
    }

    return this.prisma.venue.create({
      data: {
        ownerId,
        slug,
        countryCode,
        nameEn: dto.nameEn,
        nameAr: dto.nameAr,
        descriptionEn: dto.descriptionEn,
        descriptionAr: dto.descriptionAr,
        districtId: dto.districtId,
        governorateId: dto.governorateId,
        address: dto.address,
        lat: dto.lat,
        lng: dto.lng,
        geohash: encodeGeohash(dto.lat, dto.lng),
        surface: dto.surface,
        instantBook: dto.instantBook ?? true,
        cancellationPolicy: dto.cancellationPolicy,
        status: 'pending',
        sports: dto.sportIds
          ? { create: dto.sportIds.map((sportId) => ({ sportId })) }
          : undefined,
        amenities: dto.amenityKeys
          ? {
              create: dto.amenityKeys.map((key) => ({
                amenity: { connect: { key } },
              })),
            }
          : undefined,
      },
      include: { sports: true, amenities: { include: { amenity: true } } },
    });
  }

  private async assertOwnership(
    venueId: string,
    ownerId: string,
    isPrivileged: boolean,
  ) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    if (!isPrivileged && venue.ownerId !== ownerId) {
      throw new ForbiddenException('Not your venue');
    }
    return venue;
  }

  async update(
    venueId: string,
    ownerId: string,
    isPrivileged: boolean,
    dto: UpdateVenueDto,
  ) {
    await this.assertOwnership(venueId, ownerId, isPrivileged);
    const geo =
      dto.lat != null && dto.lng != null
        ? {
            lat: dto.lat,
            lng: dto.lng,
            geohash: encodeGeohash(dto.lat, dto.lng),
          }
        : {};

    return this.prisma.venue.update({
      where: { id: venueId },
      data: {
        nameEn: dto.nameEn,
        nameAr: dto.nameAr,
        descriptionEn: dto.descriptionEn,
        descriptionAr: dto.descriptionAr,
        districtId: dto.districtId,
        governorateId: dto.governorateId,
        address: dto.address,
        surface: dto.surface,
        instantBook: dto.instantBook,
        cancellationPolicy: dto.cancellationPolicy,
        ...geo,
      },
    });
  }

  async approve(adminId: string, venueId: string) {
    await this.getById(venueId);
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { status: 'active', approvedById: adminId, approvedAt: new Date() },
    });
  }

  async setStatus(venueId: string, status: VenueStatus) {
    await this.getById(venueId);
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { status },
    });
  }

  async getById(id: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id },
      include: {
        courts: { include: { pricingRules: true, sport: true } },
        photos: { orderBy: { position: 'asc' } },
        amenities: { include: { amenity: true } },
        sports: { include: { sport: true } },
      },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    return venue;
  }

  async getBySlug(slug: string) {
    const include = {
      courts: { include: { pricingRules: true, sport: true } },
      photos: { orderBy: { position: 'asc' as const } },
      amenities: { include: { amenity: true } },
      sports: { include: { sport: true } },
      reviews: {
        orderBy: { createdAt: 'desc' as const },
        take: 20,
        include: {
          user: { select: { id: true, name: true, avatarUrl: true } },
        },
      },
    };
    const venue =
      (await this.prisma.venue.findUnique({
        where: { slug },
        include,
      })) ??
      (await this.prisma.venue.findUnique({
        where: { id: slug },
        include,
      }));
    if (!venue || venue.status !== 'active')
      throw new NotFoundException('Venue not found');
    return venue;
  }

  listMine(ownerId: string) {
    return this.prisma.venue.findMany({
      where: { ownerId },
      include: { courts: true },
    });
  }

  private parseBbox(
    bbox?: string,
  ): { west: number; south: number; east: number; north: number } | null {
    if (!bbox) return null;
    const [west, south, east, north] = bbox.split(',').map(Number);
    if (![west, south, east, north].every((n) => Number.isFinite(n))) return null;
    return { west, south, east, north };
  }

  private parseCenter(
    center?: string,
  ): { lat: number; lng: number } | null {
    if (!center) return null;
    const [lat, lng] = center.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }

  private async resolveSearchScope(query: SearchVenuesDto) {
    let countryCode = normalizeCountryCode(query.country);
    const sportKey = query.sportId ?? query.sport;
    const districtKey = query.districtId ?? query.district;
    const govKey = query.governorateId ?? query.governorate;
    const radiusKm =
      query.radiusKm ?? (query.radius ? query.radius / 1000 : undefined);
    const center = this.parseCenter(query.center);
    let bbox = this.parseBbox(query.bbox);

    if (!bbox && center && radiusKm) {
      const [west, south, east, north] = bboxFromRadiusKm(
        center.lat,
        center.lng,
        radiusKm,
      );
      bbox = { west, south, east, north };
    }

    const hasScope =
      !!countryCode ||
      !!bbox ||
      !!center ||
      !!districtKey ||
      !!govKey;
    if (!hasScope) {
      // Public explore/home omit a scope — default to the primary market.
      countryCode = 'EG';
    }

    const [district, governorate, sport] = await Promise.all([
      districtKey
        ? this.prisma.district.findFirst({
            where: {
              OR: [{ id: districtKey }, { slug: districtKey }],
              ...(countryCode
                ? { governorate: { countryCode } }
                : {}),
            },
            select: {
              id: true,
              polygon: true,
              governorate: { select: { countryCode: true } },
            },
          })
        : Promise.resolve(null),
      govKey
        ? this.prisma.governorate.findFirst({
            where: {
              OR: [{ id: govKey }, { slug: govKey }],
              ...(countryCode ? { countryCode } : {}),
            },
          })
        : Promise.resolve(null),
      sportKey
        ? this.prisma.sportCategory.findFirst({
            where: { OR: [{ id: sportKey }, { slug: sportKey }] },
          })
        : Promise.resolve(null),
    ]);

    const resolvedCountry =
      countryCode ??
      governorate?.countryCode ??
      district?.governorate.countryCode;

    let availabilityFilter: Prisma.VenueWhereInput | undefined;
    if (query.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
        throw new BadRequestException('date must be YYYY-MM-DD');
      }
      const country = resolvedCountry
        ? await this.prisma.countryConfig.findUnique({
            where: { code: resolvedCountry },
            select: { timezone: true },
          })
        : null;
      const tz = country?.timezone ?? 'Africa/Cairo';
      const from = query.from ?? '00:00';
      const to = query.to ?? '23:45';
      if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) {
        throw new BadRequestException('from/to must be HH:mm');
      }
      const windowStart = zonedWallTimeToUtc(query.date, from, tz);
      const windowEnd = zonedWallTimeToUtc(query.date, to, tz);
      availabilityFilter = {
        courts: {
          some: {
            AND: [
              {
                bookings: {
                  none: {
                    status: { in: ['held', 'confirmed'] },
                    slotStart: { lt: windowEnd },
                    slotEnd: { gt: windowStart },
                  },
                },
              },
              {
                calendarBlocks: {
                  none: {
                    startsAt: { lt: windowEnd },
                    endsAt: { gt: windowStart },
                  },
                },
              },
            ],
          },
        },
      };
    }

    const amenityKeys = query.amenities
      ? query.amenities.split(',').filter(Boolean)
      : [];

    const where: Prisma.VenueWhereInput = {
      status: 'active',
      ...(resolvedCountry ? { countryCode: resolvedCountry } : {}),
      ...(sport ? { sports: { some: { sportId: sport.id } } } : {}),
      ...(district ? { districtId: district.id } : {}),
      ...(governorate ? { governorateId: governorate.id } : {}),
      ...(query.instantBook ? { instantBook: true } : {}),
      ...(query.featured ? { featured: true } : {}),
      ...(query.surface ? { surface: query.surface } : {}),
      ...(availabilityFilter ?? {}),
      ...(query.ratingMin != null
        ? { ratingAvg: { gte: query.ratingMin } }
        : {}),
      ...(query.priceMin != null || query.priceMax != null
        ? {
            priceFromAmount: {
              ...(query.priceMin != null ? { gte: query.priceMin } : {}),
              ...(query.priceMax != null ? { lte: query.priceMax } : {}),
            },
          }
        : {}),
      ...(query.hasOffers
        ? {
            promoCodes: {
              some: {
                active: true,
                validFrom: { lte: new Date() },
                validUntil: { gte: new Date() },
              },
            },
          }
        : {}),
      ...(amenityKeys.length
        ? {
            amenities: {
              some: { amenity: { key: { in: amenityKeys } } },
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { nameEn: { contains: query.search, mode: 'insensitive' } },
              { nameAr: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    if (bbox && !district) {
      where.lat = { gte: bbox.south, lte: bbox.north };
      where.lng = { gte: bbox.west, lte: bbox.east };
      const prefixes = geohashPrefixesForBbox(
        bbox.west,
        bbox.south,
        bbox.east,
        bbox.north,
        4,
      );
      if (prefixes.length > 0 && prefixes.length <= 32) {
        where.AND = [
          { OR: prefixes.map((p) => ({ geohash: { startsWith: p } })) },
        ];
      }
    }

    return { where, district, center, radiusKm, resolvedCountry };
  }

  private orderByFor(sort?: string): Prisma.VenueOrderByWithRelationInput[] {
    switch (sort) {
      case 'price':
        return [{ priceFromAmount: 'asc' }, { ratingAvg: 'desc' }];
      case 'rating':
        return [{ ratingAvg: 'desc' }, { ratingCount: 'desc' }];
      case 'popularity':
        return [{ ratingCount: 'desc' }, { ratingAvg: 'desc' }];
      case 'discount':
        return [{ ratingCount: 'desc' }, { priceFromAmount: 'asc' }];
      case 'newest':
        return [{ createdAt: 'desc' }];
      default:
        return [{ featured: 'desc' }, { ratingAvg: 'desc' }];
    }
  }

  async refreshVenuePriceFrom(venueId: string) {
    const agg = await this.prisma.pricingRule.aggregate({
      where: { court: { venueId } },
      _min: { priceAmount: true },
    });
    const sample = await this.prisma.pricingRule.findFirst({
      where: { court: { venueId } },
      select: { currency: true },
    });
    await this.prisma.venue.update({
      where: { id: venueId },
      data: {
        priceFromAmount: agg._min.priceAmount,
        priceFromCurrency: sample?.currency ?? null,
      },
    });
  }

  async search(query: SearchVenuesDto) {
    const { where, center, radiusKm } = await this.resolveSearchScope(query);
    const page = query.page ?? 1;
    const perPage = Math.min(query.perPage ?? 20, 50);

    if (center && radiusKm && (query.sort === 'distance' || !query.sort)) {
      const candidates = await this.prisma.venue.findMany({
        where,
        select: { id: true, lat: true, lng: true },
        take: 5000,
      });
      const ranked = candidates
        .map((v) => ({ id: v.id, d: haversineKm(center.lat, center.lng, v.lat, v.lng) }))
        .filter((x) => x.d <= radiusKm)
        .sort((a, b) => a.d - b.d);
      const total = ranked.length;
      const pageIds = ranked
        .slice((page - 1) * perPage, page * perPage)
        .map((x) => x.id);
      const items = pageIds.length
        ? await this.prisma.venue.findMany({
            where: { id: { in: pageIds } },
            include: {
              sports: { include: { sport: true } },
              photos: { orderBy: { position: 'asc' }, take: 1 },
              district: true,
            },
          })
        : [];
      const byId = new Map(items.map((v) => [v.id, v]));
      return {
        items: pageIds.map((id) => byId.get(id)).filter(Boolean),
        pagination: buildPagination(page, perPage, total),
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.venue.findMany({
        where,
        include: {
          sports: { include: { sport: true } },
          photos: { orderBy: { position: 'asc' }, take: 1 },
          district: true,
        },
        orderBy: this.orderByFor(query.sort),
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.venue.count({ where }),
    ]);
    return {
      items,
      pagination: buildPagination(page, perPage, total),
    };
  }

  async searchExplore(query: SearchVenuesDto) {
    const include = (query.include ?? 'pins,cards,count').split(',');
    const { where, district, center, radiusKm, resolvedCountry } =
      await this.resolveSearchScope(query);

    const country = resolvedCountry
      ? await this.prisma.countryConfig.findUnique({
          where: { code: resolvedCountry },
          select: { currency: true },
        })
      : null;
    const fallbackCurrency = country?.currency ?? 'EGP';

    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? query.perPage ?? 20, 50);
    const PIN_SCAN_CAP = 2000;
    const PIN_CAP = 500;

    const needsDistance = !!(center && radiusKm);

    const pinSelect = {
      id: true,
      slug: true,
      lat: true,
      lng: true,
      priceFromAmount: true,
      priceFromCurrency: true,
      ratingAvg: true,
      instantBook: true,
      sports: { select: { sport: { select: { slug: true } } } },
    } as const;

    let pinRows: Array<{
      id: string;
      slug: string;
      lat: number;
      lng: number;
      priceFromAmount: number | null;
      priceFromCurrency: string | null;
      ratingAvg: number;
      instantBook: boolean;
      sports: { sport: { slug: string } }[];
    }> = [];

    if (include.includes('pins') || needsDistance) {
      pinRows = await this.prisma.venue.findMany({
        where,
        select: pinSelect,
        take: PIN_SCAN_CAP,
      });
      if (needsDistance && center && radiusKm) {
        pinRows = pinRows.filter(
          (v) => haversineKm(center.lat, center.lng, v.lat, v.lng) <= radiusKm,
        );
        if (query.sort === 'distance' || !query.sort) {
          pinRows.sort(
            (a, b) =>
              haversineKm(center.lat, center.lng, a.lat, a.lng) -
              haversineKm(center.lat, center.lng, b.lat, b.lng),
          );
        }
      }
    }

    const count = needsDistance
      ? pinRows.length
      : await this.prisma.venue.count({ where });

    const clustered = include.includes('pins')
      ? clusterByGeohash(pinRows, PIN_CAP)
      : { pins: [] as typeof pinRows, clusters: [] };

    const pins = clustered.pins.map((v) => ({
      id: v.id,
      slug: v.slug,
      lat: v.lat,
      lng: v.lng,
      priceFrom: {
        amount: v.priceFromAmount ?? 0,
        currency: v.priceFromCurrency ?? fallbackCurrency,
      },
      sportIds: v.sports.map((s) => s.sport.slug),
      availableTonight: v.instantBook,
      rating: v.ratingAvg,
    }));

    let cards:
      | { items: unknown[]; page: number; totalPages: number }
      | undefined;
    if (include.includes('cards')) {
      const totalPages = Math.max(1, Math.ceil(count / pageSize));
      let cardRows;
      if (needsDistance) {
        const pageIds = pinRows
          .slice((page - 1) * pageSize, page * pageSize)
          .map((v) => v.id);
        const fetched = pageIds.length
          ? await this.prisma.venue.findMany({
              where: { id: { in: pageIds } },
              include: {
                sports: { include: { sport: true } },
                photos: { orderBy: { position: 'asc' }, take: 1 },
                district: true,
                promoCodes: {
                  where: {
                    validFrom: { lte: new Date() },
                    validUntil: { gte: new Date() },
                  },
                  take: 1,
                },
              },
            })
          : [];
        const byId = new Map(fetched.map((v) => [v.id, v]));
        cardRows = pageIds.map((id) => byId.get(id)).filter(Boolean);
      } else {
        cardRows = await this.prisma.venue.findMany({
          where,
          include: {
            sports: { include: { sport: true } },
            photos: { orderBy: { position: 'asc' }, take: 1 },
            district: true,
            promoCodes: {
              where: {
                validFrom: { lte: new Date() },
                validUntil: { gte: new Date() },
              },
              take: 1,
            },
          },
          orderBy: this.orderByFor(query.sort),
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
      }

      cards = {
        items: cardRows.map((v) => ({
          id: v.id,
          slug: v.slug,
          nameEn: v.nameEn,
          nameAr: v.nameAr,
          lat: v.lat,
          lng: v.lng,
          ratingAvg: v.ratingAvg,
          ratingCount: v.ratingCount,
          instantBook: v.instantBook,
          featured: v.featured,
          sportIds: v.sports.map((s) => s.sport.slug),
          priceFrom: {
            amount: v.priceFromAmount ?? 0,
            currency: v.priceFromCurrency ?? fallbackCurrency,
          },
          availableTonight: v.instantBook,
          hasOffers: v.promoCodes.length > 0,
          photo: v.photos[0]?.url ?? null,
          district: v.district
            ? {
                id: v.district.id,
                nameEn: v.district.nameEn,
                nameAr: v.district.nameAr,
              }
            : null,
        })),
        page,
        totalPages,
      };
    }

    return {
      count,
      pins: include.includes('pins') ? pins : [],
      clusters: include.includes('pins') ? clustered.clusters : [],
      cards,
      boundary: toSearchBoundary(district?.polygon),
    };
  }

  async favorite(userId: string, venueId: string) {
    await this.getById(venueId);
    return this.prisma.favoriteVenue.upsert({
      where: { userId_venueId: { userId, venueId } },
      update: {},
      create: { userId, venueId },
    });
  }

  async unfavorite(userId: string, venueId: string) {
    await this.prisma.favoriteVenue.deleteMany({
      where: { userId, venueId },
    });
  }

  // ---- Courts ----
  async addCourt(
    venueId: string,
    ownerId: string,
    isPrivileged: boolean,
    dto: CreateCourtDto,
  ) {
    await this.assertOwnership(venueId, ownerId, isPrivileged);
    return this.prisma.court.create({ data: { venueId, ...dto } });
  }

  async updateCourt(
    courtId: string,
    ownerId: string,
    isPrivileged: boolean,
    dto: UpdateCourtDto,
  ) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { venue: true },
    });
    if (!court) throw new NotFoundException('Court not found');
    if (!isPrivileged && court.venue.ownerId !== ownerId)
      throw new ForbiddenException('Not your venue');
    return this.prisma.court.update({ where: { id: courtId }, data: dto });
  }

  async deleteCourt(courtId: string, ownerId: string, isPrivileged: boolean) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { venue: true },
    });
    if (!court) throw new NotFoundException('Court not found');
    if (!isPrivileged && court.venue.ownerId !== ownerId)
      throw new ForbiddenException('Not your venue');
    const deleted = await this.prisma.court.delete({ where: { id: courtId } });
    await this.refreshVenuePriceFrom(court.venueId);
    return deleted;
  }

  // ---- Pricing rules ----
  async addPricingRule(
    courtId: string,
    ownerId: string,
    isPrivileged: boolean,
    dto: UpsertPricingRuleDto,
  ) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { venue: { include: { country: true } } },
    });
    if (!court) throw new NotFoundException('Court not found');
    if (!isPrivileged && court.venue.ownerId !== ownerId)
      throw new ForbiddenException('Not your venue');
    const created = await this.prisma.pricingRule.create({
      data: {
        courtId,
        ...dto,
        currency: dto.currency ?? court.venue.country.currency,
      },
    });
    await this.refreshVenuePriceFrom(court.venueId);
    return created;
  }

  async updatePricingRule(
    ruleId: string,
    ownerId: string,
    isPrivileged: boolean,
    dto: UpsertPricingRuleDto,
  ) {
    const rule = await this.prisma.pricingRule.findUnique({
      where: { id: ruleId },
      include: { court: { include: { venue: true } } },
    });
    if (!rule) throw new NotFoundException('Pricing rule not found');
    if (!isPrivileged && rule.court.venue.ownerId !== ownerId)
      throw new ForbiddenException('Not your venue');
    const updated = await this.prisma.pricingRule.update({
      where: { id: ruleId },
      data: dto,
    });
    await this.refreshVenuePriceFrom(rule.court.venueId);
    return updated;
  }

  async deletePricingRule(
    ruleId: string,
    ownerId: string,
    isPrivileged: boolean,
  ) {
    const rule = await this.prisma.pricingRule.findUnique({
      where: { id: ruleId },
      include: { court: { include: { venue: true } } },
    });
    if (!rule) throw new NotFoundException('Pricing rule not found');
    if (!isPrivileged && rule.court.venue.ownerId !== ownerId)
      throw new ForbiddenException('Not your venue');
    const deleted = await this.prisma.pricingRule.delete({
      where: { id: ruleId },
    });
    await this.refreshVenuePriceFrom(rule.court.venueId);
    return deleted;
  }

  // ---- Photos ----
  async addPhoto(
    venueId: string,
    ownerId: string,
    isPrivileged: boolean,
    url: string,
  ) {
    await this.assertOwnership(venueId, ownerId, isPrivileged);
    const count = await this.prisma.venuePhoto.count({ where: { venueId } });
    return this.prisma.venuePhoto.create({
      data: { venueId, url, position: count },
    });
  }

  async reorderPhotos(
    venueId: string,
    ownerId: string,
    isPrivileged: boolean,
    orderedIds: string[],
  ) {
    await this.assertOwnership(venueId, ownerId, isPrivileged);
    await this.prisma.$transaction(
      orderedIds.map((id, position) =>
        this.prisma.venuePhoto.update({ where: { id }, data: { position } }),
      ),
    );
    return this.prisma.venuePhoto.findMany({
      where: { venueId },
      orderBy: { position: 'asc' },
    });
  }

  async deletePhoto(
    venueId: string,
    photoId: string,
    ownerId: string,
    isPrivileged: boolean,
  ) {
    await this.assertOwnership(venueId, ownerId, isPrivileged);
    return this.prisma.$transaction(async (tx) => {
      const photo = await tx.venuePhoto.findFirst({
        where: { id: photoId, venueId },
      });
      if (!photo) throw new NotFoundException('Photo not found');
      await tx.venuePhoto.delete({ where: { id: photoId } });
      const remaining = await tx.venuePhoto.findMany({
        where: { venueId },
        orderBy: { position: 'asc' },
      });
      await Promise.all(
        remaining.map((row, position) =>
          tx.venuePhoto.update({ where: { id: row.id }, data: { position } }),
        ),
      );
      return photo;
    });
  }

  // ---- Admin list ----
  listPendingApproval() {
    return this.prisma.venue.findMany({
      where: { status: 'pending' },
      include: {
        owner: { select: { id: true, name: true, email: true, phone: true } },
      },
    });
  }
}
