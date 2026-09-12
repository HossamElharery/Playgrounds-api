import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePageSeoDto } from './page-seo.dto';

const PAGE_KEYS = new Set(['homepage', 'about', 'partners']);

@Injectable()
export class PageSeoService {
  constructor(private readonly prisma: PrismaService) {}

  list() { return this.prisma.pageSeoOverride.findMany({ orderBy: { key: 'asc' } }); }

  async get(key: string) {
    if (!PAGE_KEYS.has(key)) throw new BadRequestException('Unknown marketing page');
    const page = await this.prisma.pageSeoOverride.findUnique({ where: { key } });
    if (!page) throw new NotFoundException('Page SEO not configured');
    return page;
  }

  update(adminId: string, key: string, dto: UpdatePageSeoDto) {
    if (!PAGE_KEYS.has(key)) throw new BadRequestException('Unknown marketing page');
    const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
    const data = {
      titleAr: clean(dto.titleAr), titleEn: clean(dto.titleEn),
      descriptionAr: clean(dto.descriptionAr), descriptionEn: clean(dto.descriptionEn),
      updatedById: adminId,
    };
    if (Object.values(data).some((value) => !value)) {
      throw new BadRequestException('Marketing SEO fields cannot be empty');
    }
    return this.prisma.pageSeoOverride.upsert({
      where: { key }, update: data, create: { key, ...data },
    });
  }
}
