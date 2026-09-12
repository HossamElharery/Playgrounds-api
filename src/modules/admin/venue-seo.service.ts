import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateVenueSeoDto } from './dto/venue-seo.dto';

@Injectable()
export class VenueSeoService {
  constructor(private readonly prisma: PrismaService) {}

  async update(actorUserId: string, venueId: string, dto: UpdateVenueSeoDto) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    const normalize = (value: string | undefined) =>
      value === undefined ? undefined : value.trim() || null;
    const data = {
      seoTitleOverrideAr: normalize(dto.seoTitleOverrideAr),
      seoTitleOverrideEn: normalize(dto.seoTitleOverrideEn),
      seoDescriptionOverrideAr: normalize(dto.seoDescriptionOverrideAr),
      seoDescriptionOverrideEn: normalize(dto.seoDescriptionOverrideEn),
    };

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.venue.update({ where: { id: venueId }, data });
      await tx.auditLogEntry.create({
        data: {
          actorUserId,
          action: 'admin.venue.seo.update',
          targetType: 'venue',
          targetId: venueId,
          metadata: {
            before: {
              seoTitleOverrideAr: venue.seoTitleOverrideAr,
              seoTitleOverrideEn: venue.seoTitleOverrideEn,
              seoDescriptionOverrideAr: venue.seoDescriptionOverrideAr,
              seoDescriptionOverrideEn: venue.seoDescriptionOverrideEn,
            },
            after: data,
          },
        },
      });
      return updated;
    });
  }
}
