import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildAreaRollup, isNamedArea, type CatalogDistrict } from './area-catalog.util';

export interface CatalogGovernorate {
  id: string;
  slug: string | null;
  nameAr: string;
  nameEn: string;
  countryCode: string;
}

export interface AreaCatalog {
  governorates: CatalogGovernorate[];
  areas: CatalogDistrict[];
  governorateById: Map<string, CatalogGovernorate>;
  areaById: Map<string, CatalogDistrict>;
  areaOf: Map<string, string>;
  districtIdsOf: Map<string, string[]>;
}

const TTL_MS = 10 * 60_000;

@Injectable()
export class AreaCatalogService {
  private cached?: { until: number; value: AreaCatalog };
  private pending?: Promise<AreaCatalog>;

  constructor(private readonly prisma: PrismaService) {}

  get(): Promise<AreaCatalog> {
    if (this.cached && this.cached.until > Date.now()) return Promise.resolve(this.cached.value);
    this.pending ??= this.load()
      .then((value) => {
        this.cached = { until: Date.now() + TTL_MS, value };
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  async searchDistrictIds(districtId: string): Promise<string[]> {
    const catalog = await this.get();
    return catalog.districtIdsOf.get(districtId) ?? [districtId];
  }

  async areaFor(districtId: string | null | undefined): Promise<CatalogDistrict | null> {
    if (!districtId) return null;
    const catalog = await this.get();
    const areaId = catalog.areaOf.get(districtId);
    return areaId ? catalog.areaById.get(areaId) ?? null : null;
  }

  private async load(): Promise<AreaCatalog> {
    const [governorates, districts] = await Promise.all([
      this.prisma.governorate.findMany({
        select: { id: true, slug: true, nameAr: true, nameEn: true, countryCode: true },
        orderBy: { nameEn: 'asc' },
      }),
      this.prisma.district.findMany({
        select: { id: true, slug: true, nameAr: true, nameEn: true, governorateId: true, lat: true, lng: true },
      }),
    ]);
    const areaOf = buildAreaRollup(districts);
    const areas = districts.filter(isNamedArea).sort((a, b) => a.nameEn.localeCompare(b.nameEn));
    const districtIdsOf = new Map<string, string[]>();
    for (const [districtId, areaId] of areaOf) {
      const list = districtIdsOf.get(areaId) ?? [];
      list.push(districtId);
      districtIdsOf.set(areaId, list);
    }
    return {
      governorates,
      areas,
      governorateById: new Map(governorates.map((g) => [g.id, g])),
      areaById: new Map(areas.map((a) => [a.id, a])),
      areaOf,
      districtIdsOf,
    };
  }
}

@Global()
@Module({
  providers: [AreaCatalogService],
  exports: [AreaCatalogService],
})
export class AreaCatalogModule {}
