import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeoService } from '../geo/geo.service';

const CONTEXT_TTL_MS = 60_000;

interface CatalogEntry {
  slug: string;
  nameAr: string;
  nameEn: string;
}

interface Catalog {
  sports: CatalogEntry[];
  districts: CatalogEntry[];
}

const SYNONYMS: Record<string, string> = {
  'بادل': 'padel',
  'خماسي': '5-a-side football court',
  'كورة': 'football',
  'بلاستيشن': 'playstation',
  'بلايستيشن': 'playstation',
  'سنوكر': 'billiards/snooker',
  'بلياردو': 'billiards/snooker',
};

@Injectable()
export class AiContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
  ) {}

  private cache: { exp: number; value: Catalog } | null = null;

  private async loadCatalog(): Promise<Catalog> {
    if (this.cache && this.cache.exp > Date.now()) return this.cache.value;

    const [sports, districts] = await Promise.all([
      this.prisma.sportCategory.findMany({ select: { slug: true, nameAr: true, nameEn: true } }),
      this.geo.listDistricts(undefined, undefined, 'EG'),
    ]);

    const value: Catalog = {
      sports,
      districts: districts.filter((d): d is typeof d & { slug: string } => !!d.slug),
    };
    this.cache = { exp: Date.now() + CONTEXT_TTL_MS, value };
    return value;
  }

  async listCatalog(): Promise<Catalog> {
    return this.loadCatalog();
  }

  async buildPlatformContext(): Promise<string> {
    const { sports, districts } = await this.loadCatalog();
    return [
      `الرياضات المتاحة (استخدم الـ slug بالظبط): ${sports.map((s) => `${s.slug}=${s.nameAr}/${s.nameEn}`).join(', ')}`,
      `المناطق المتاحة (استخدم الـ slug بالظبط): ${districts.map((d) => `${d.slug}=${d.nameAr}/${d.nameEn}`).join(', ')}`,
      `مرادفات محلية شائعة: ${Object.entries(SYNONYMS).map(([ar, en]) => `${ar}=${en}`).join(', ')}`,
    ].join('\n');
  }

  async listValidSlugs(): Promise<{ sports: Set<string>; districts: Set<string> }> {
    const { sports, districts } = await this.loadCatalog();
    return {
      sports: new Set(sports.map((s) => s.slug)),
      districts: new Set(districts.map((d) => d.slug)),
    };
  }

  async buildVenueContext(venueId: string): Promise<string> {
    const courts = await this.prisma.court.findMany({
      where: { venueId },
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    return `ملاعب/كورتات هذه المنشأة: ${courts.map((c) => c.name).join(', ')}`;
  }
}
