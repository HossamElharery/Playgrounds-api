import { computeVenueState } from '../../common/utils/venue-visibility.util';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AreaCatalogService } from '../geo/area-catalog.service';
import type { PartnerVisitDto } from './partner-links.dto';
import {
  PARTNER_EVENT_NAME,
  foldPartnerStats,
  toEmbedCard,
  type EmbedVenueCard,
  type PartnerStatRow,
  type PartnerStats,
} from './partner-links.util';

@Injectable()
export class PartnerLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly areas: AreaCatalogService,
  ) {}

  async embedCard(slug: string): Promise<EmbedVenueCard> {
    const venue = await this.prisma.venue.findUnique({
      where: { slug },
      select: {
        slug: true,
        status: true,
        ownerListingEnabled: true,
        adminHidden: true,
        instantBook: true,
        operationsEnabled: true,
        nameAr: true,
        nameEn: true,
        currency: true,
        priceFromAmount: true,
        weeklyHours: true,
        ratingAvg: true,
        ratingCount: true,
        districtId: true,
        photos: {
          orderBy: { position: 'asc' },
          take: 1,
          select: { url: true },
        },
        governorate: { select: { nameAr: true, nameEn: true } },
      },
    });
    if (!venue || !computeVenueState(venue).publicVisible)
      throw new NotFoundException('Venue not found');
    const area = await this.areas.areaFor(venue.districtId).catch(() => null);
    return toEmbedCard(venue, area);
  }

  async recordVisit(
    dto: PartnerVisitDto,
    userId?: string,
  ): Promise<{ ok: true }> {
    const venue = await this.prisma.venue.findUnique({
      where: { slug: dto.venueSlug },
      select: { id: true, status: true, ownerListingEnabled: true, adminHidden: true, instantBook: true, operationsEnabled: true },
    });
    if (!venue || !computeVenueState(venue).publicVisible) return { ok: true };
    await this.prisma.analyticsEvent
      .create({
        data: {
          name: PARTNER_EVENT_NAME[dto.event],
          userId: userId ?? null,
          payload: {
            venueId: venue.id,
            source: dto.source.toLowerCase(),
            medium: dto.medium?.toLowerCase() ?? null,
            campaign: dto.campaign?.toLowerCase() ?? null,
          },
        },
      })
      .catch(() => undefined);
    return { ok: true };
  }

  async stats(
    venueId: string,
    ownerId: string,
    privileged: boolean,
  ): Promise<PartnerStats> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { ownerId: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    if (!privileged && venue.ownerId !== ownerId)
      throw new ForbiddenException('Not your venue');
    const rows = await this.prisma.$queryRaw<PartnerStatRow[]>`
      SELECT "name",
             "payload"->>'medium' AS "medium",
             COUNT(*)::int AS "total",
             (COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '30 days'))::int AS "last30"
        FROM "AnalyticsEvent"
       WHERE "name" IN (${PARTNER_EVENT_NAME.landing}, ${PARTNER_EVENT_NAME.contact_click})
         AND "payload"->>'venueId' = ${venueId}
       GROUP BY 1, 2`;
    return foldPartnerStats(rows);
  }
}
