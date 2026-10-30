import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeCountryCode } from '../../common/geo/country.util';
import {
  haversineKm,
  pointInPolygon,
  toSearchBoundary,
} from '../../common/utils/geo.util';
import {
  cityView,
  fallbackCityView,
  findWorldCity,
  findWorldState,
  isCatalogLocationId,
  stateView,
  worldCities,
  worldCountries,
  worldCountry,
  worldStates,
} from './world-geo.catalog';

const NEAREST_DISTRICT_KM = 50;

export type ResolvedArea = {
  governorateId: string | null;
  districtId: string | null;
  district: { id: string; nameEn: string; nameAr: string } | null;
  governorate: {
    id: string;
    nameEn: string;
    nameAr: string;
    countryCode: string;
  } | null;
};

const CATALOG_TTL_MS = 60_000;

@Injectable()
export class GeoService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly pending = new Map<string, Promise<unknown>>();
  private cache = new Map<string, { exp: number; value: unknown }>();

  private cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return Promise.resolve(hit.value as T);
    const pending = this.pending.get(key);
    if (pending) return pending as Promise<T>;
    const request = Promise.resolve()
      .then(loader)
      .then((value) => {
        for (const [cachedKey, entry] of this.cache)
          if (entry.exp <= Date.now()) this.cache.delete(cachedKey);
        if (this.cache.size < 256 || this.cache.has(key)) {
          this.cache.set(key, { exp: Date.now() + CATALOG_TTL_MS, value });
        }
        return value;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, request);
    return request;
  }

  listCountries() {
    return this.cached('countries', async () => {
      const [catalog, configured] = await Promise.all([
        worldCountries(),
        this.prisma.countryConfig.findMany({
          where: { active: true },
          orderBy: { nameEn: 'asc' },
          select: {
            code: true,
            nameEn: true,
            nameAr: true,
            currency: true,
            phoneCallingCode: true,
            timezone: true,
            locale: true,
            weekendDays: true,
            paymentMethods: true,
            lat: true,
            lng: true,
          },
        }),
      ]);
      const overrides = new Map(
        configured.map((country) => [country.code, country]),
      );
      return catalog
        .map((country) => ({ ...country, ...overrides.get(country.code) }))
        .sort((a, b) => a.nameEn.localeCompare(b.nameEn));
    });
  }

  async getCountry(code: string) {
    const countryCode = normalizeCountryCode(code);
    if (!countryCode) throw new BadRequestException('Invalid country code');
    const country = await this.cached(`country:${countryCode}`, async () => {
      const [catalog, configured] = await Promise.all([
        worldCountry(countryCode),
        this.prisma.countryConfig.findFirst({
          where: { code: countryCode, active: true },
          select: {
            code: true,
            nameEn: true,
            nameAr: true,
            currency: true,
            phoneCallingCode: true,
            timezone: true,
            locale: true,
            weekendDays: true,
            paymentMethods: true,
            serviceFeePct: true,
            lat: true,
            lng: true,
          },
        }),
      ]);
      return catalog ? { ...catalog, ...configured } : configured;
    });
    if (!country) throw new NotFoundException('Country not found');
    return country;
  }

  listGovernorates(country?: string) {
    const countryCode = normalizeCountryCode(country);
    if (!countryCode) {
      throw new BadRequestException(
        'country query param is required (ISO 3166-1 alpha-2)',
      );
    }
    return this.cached(`govs:${countryCode}`, async () => {
      const configured = await this.prisma.governorate.findMany({
        where: { countryCode },
        orderBy: { nameEn: 'asc' },
        select: {
          id: true,
          slug: true,
          nameEn: true,
          nameAr: true,
          countryCode: true,
        },
      });
      // A hand-maintained local catalog (currently Egypt) remains authoritative.
      // Rows materialised from the world catalog must not hide its other regions.
      if (configured.some((item) => !item.id.startsWith('csc-state-'))) {
        return configured;
      }
      const overrides = new Map(configured.map((item) => [item.id, item]));
      return (await worldStates(countryCode)).map((state) => {
        const item = stateView(state);
        return { ...item, ...overrides.get(item.id) };
      });
    });
  }

  async listDistricts(
    governorateId?: string,
    govSlug?: string,
    country?: string,
    slim = false,
  ) {
    const countryCode = normalizeCountryCode(country);
    if (!governorateId && !govSlug && !countryCode) {
      throw new BadRequestException(
        'governorateId, gov, or country is required',
      );
    }
    const key = `districts:${JSON.stringify([governorateId ?? '', govSlug ?? '', countryCode ?? ''])}${slim ? ':slim' : ''}`;
    return this.cached(key, async () => {
      if (governorateId?.startsWith('csc-state-')) {
        if (!countryCode) {
          throw new BadRequestException(
            'country is required for catalog locations',
          );
        }
        const state = await findWorldState(countryCode, governorateId);
        if (!state) throw new NotFoundException('Region not found');
        const cities = await worldCities(countryCode, state);
        return [
          ...cities.map((city) => cityView(city, governorateId)),
          fallbackCityView(state, governorateId),
        ].sort((a, b) => a.nameEn.localeCompare(b.nameEn));
      }
      const items = await this.prisma.district.findMany({
        where: {
          ...(governorateId ? { governorateId } : {}),
          ...(govSlug
            ? {
                governorate: {
                  slug: govSlug,
                  ...(countryCode ? { countryCode } : {}),
                },
              }
            : {}),
          ...(!governorateId && !govSlug && countryCode
            ? { governorate: { countryCode } }
            : {}),
        },
        select: {
          id: true,
          slug: true,
          nameEn: true,
          nameAr: true,
          lat: true,
          lng: true,
          ...(slim ? {} : { polygon: true }),
          governorateId: true,
          ...(slim
            ? {}
            : {
                governorate: {
                  select: {
                    id: true,
                    slug: true,
                    nameEn: true,
                    nameAr: true,
                    countryCode: true,
                  },
                },
              }),
        },
        orderBy: { nameEn: 'asc' },
      });
      return items.map((d) => ({
        ...d,
        polygon: 'polygon' in d ? toSearchBoundary(d.polygon) : null,
      }));
    });
  }

  /**
   * Catalog locations are read-only until an owner submits an application.
   * Materialising only the selected country/region/city keeps the database
   * small while retaining the foreign-key guarantees used by live venues.
   */
  async ensureCatalogLocation(
    country: string | undefined,
    governorateId: string | undefined,
    districtId: string | undefined,
  ) {
    const countryCode = normalizeCountryCode(country);
    const hasCatalogId =
      isCatalogLocationId(governorateId) || isCatalogLocationId(districtId);
    if (!hasCatalogId) return;
    if (
      !countryCode ||
      !governorateId ||
      !districtId ||
      !governorateId.startsWith('csc-state-') ||
      !(
        districtId.startsWith('csc-city-') || districtId.startsWith('csc-area-')
      )
    ) {
      throw new BadRequestException('Invalid catalog location');
    }

    const [countryData, state] = await Promise.all([
      worldCountry(countryCode),
      findWorldState(countryCode, governorateId),
    ]);
    if (!countryData || !state)
      throw new BadRequestException('Invalid catalog location');
    const city = await findWorldCity(countryCode, state, districtId);
    const stateData = stateView(state);
    const districtData = city
      ? cityView(city, governorateId)
      : fallbackCityView(state, governorateId);
    if (districtData.id !== districtId)
      throw new BadRequestException('Invalid catalog location');

    await this.prisma.countryConfig.upsert({
      where: { code: countryCode },
      update: {},
      create: {
        ...countryData,
        lat: countryData.lat ?? undefined,
        lng: countryData.lng ?? undefined,
      },
    });
    await this.prisma.governorate.upsert({
      where: { id: governorateId },
      update: {},
      create: {
        id: governorateId,
        countryCode,
        slug: stateData.slug,
        nameEn: stateData.nameEn,
        nameAr: stateData.nameAr,
      },
    });
    await this.prisma.district.upsert({
      where: { id: districtId },
      update: {},
      create: {
        id: districtId,
        governorateId,
        slug: districtData.slug,
        nameEn: districtData.nameEn,
        nameAr: districtData.nameAr,
        lat: districtData.lat ?? undefined,
        lng: districtData.lng ?? undefined,
      },
    });
  }

  async resolveArea(
    lat: number,
    lng: number,
    country?: string,
  ): Promise<ResolvedArea> {
    const countryCode = normalizeCountryCode(country) ?? 'EG';
    const districts = await this.listDistricts(
      undefined,
      undefined,
      countryCode,
    );

    const inside = districts.find(
      (d) => d.polygon && pointInPolygon(lng, lat, d.polygon),
    );
    const nearest = districts.reduce<{
      district: (typeof districts)[number];
      km: number;
    } | null>((best, d) => {
      if (d.lat == null || d.lng == null) return best;
      const km = haversineKm(lat, lng, d.lat, d.lng);
      if (km > NEAREST_DISTRICT_KM) return best;
      if (!best || km < best.km) return { district: d, km };
      return best;
    }, null);
    const hit = inside ?? nearest?.district;

    if (!hit) {
      return {
        governorateId: null,
        districtId: null,
        district: null,
        governorate: null,
      };
    }

    return {
      governorateId: hit.governorateId,
      districtId: hit.id,
      district: { id: hit.id, nameEn: hit.nameEn, nameAr: hit.nameAr },
      governorate: 'governorate' in hit ? hit.governorate : null,
    };
  }
}
