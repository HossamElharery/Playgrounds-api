import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePageSeoDto } from './page-seo.dto';

const PAGE_KEYS = new Set(['homepage', 'about', 'partners']);
/** Placeholder an admin can write in marketing SEO copy; replaced by PlatformSetting.trialDays. */
export const TRIAL_TOKEN = '{trialDays}';
const DEFAULT_TRIAL_DAYS = 15;

@Injectable()
export class PageSeoService {
  constructor(private readonly prisma: PrismaService) {}

  list() { return this.prisma.pageSeoOverride.findMany({ orderBy: { key: 'asc' } }); }

  async get(key: string) {
    if (!PAGE_KEYS.has(key)) throw new BadRequestException('Unknown marketing page');
    const page = await this.prisma.pageSeoOverride.findUnique({ where: { key } });
    if (!page) throw new NotFoundException('Page SEO not configured');
    // "{trialDays}" in the copy follows the admin's free-trial setting, so SEO never quotes a stale length.
    if (![page.titleAr, page.titleEn, page.descriptionAr, page.descriptionEn].some((v) => v.includes(TRIAL_TOKEN))) return page;
    const setting = await this.prisma.platformSetting.findUnique({ where: { id: 1 }, select: { trialDays: true } });
    const days = String(setting?.trialDays ?? DEFAULT_TRIAL_DAYS);
    const fill = (v: string) => v.split(TRIAL_TOKEN).join(days);
    return {
      ...page,
      titleAr: fill(page.titleAr),
      titleEn: fill(page.titleEn),
      descriptionAr: fill(page.descriptionAr),
      descriptionEn: fill(page.descriptionEn),
    };
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
