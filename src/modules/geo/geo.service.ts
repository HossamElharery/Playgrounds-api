import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeCountryCode } from '../../common/geo/country.util';
import {
  haversineKm,
  pointInPolygon,
  toSearchBoundary,
} from '../../common/utils/geo.util';

/** Max distance from a district centroid when the GPS point is outside every polygon. */
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

  private cache = new Map<string, { exp: number; value: unknown }>();

  private cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return Promise.resolve(hit.value as T);
    return loader().then((value) => {
      this.cache.set(key, { exp: Date.now() + CATALOG_TTL_MS, value });
      return value;
    });
  }

  listCountries() {
    return this.cached('countries', () =>
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
    );
  }

  async getCountry(code: string) {
    const countryCode = normalizeCountryCode(code);
    if (!countryCode) throw new BadRequestException('Invalid country code');
    const country = await this.cached(`country:${countryCode}`, () =>
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
    );
    if (!country) throw new NotFoundException('Country not found');
    return country;
  }

  listGovernorates(country?: string) {
    const countryCode = normalizeCountryCode(country);
    if (!countryCode) {
      throw new BadRequestException('country query param is required (ISO 3166-1 alpha-2)');
    }
    return this.cached(`govs:${countryCode}`, () =>
      this.prisma.governorate.findMany({
        where: { countryCode },
        orderBy: { nameEn: 'asc' },
        select: {
          id: true,
          slug: true,
          nameEn: true,
          nameAr: true,
          countryCode: true,
        },
      }),
    );
  }

  async listDistricts(governorateId?: string, govSlug?: string, country?: string) {
    const countryCode = normalizeCountryCode(country);
    if (!governorateId && !govSlug && !countryCode) {
      throw new BadRequestException(
        'governorateId, gov, or country is required',
      );
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
        polygon: true,
        governorateId: true,
        governorate: {
          select: { id: true, slug: true, nameEn: true, nameAr: true, countryCode: true },
        },
      },
      orderBy: { nameEn: 'asc' },
    });
    return items.map((d) => ({
      ...d,
      polygon: toSearchBoundary(d.polygon),
    }));
  }

  /**
   * Map GPS to our catalog: polygon hit first, then nearest district centroid
   * within 50km. Unknown coordinates still return nulls so we can store lat/lng.
   */
  async resolveArea(lat: number, lng: number, country?: string): Promise<ResolvedArea> {
    const countryCode = normalizeCountryCode(country) ?? 'EG';
    const districts = await this.listDistricts(undefined, undefined, countryCode);

    const inside = districts.find(
      (d) => d.polygon && pointInPolygon(lng, lat, d.polygon),
    );
    const nearest = districts.reduce<{ district: (typeof districts)[number]; km: number } | null>(
      (best, d) => {
        if (d.lat == null || d.lng == null) return best;
        const km = haversineKm(lat, lng, d.lat, d.lng);
        if (km > NEAREST_DISTRICT_KM) return best;
        if (!best || km < best.km) return { district: d, km };
        return best;
      },
      null,
    );
    const hit = inside ?? nearest?.district;

    if (!hit) {
      return { governorateId: null, districtId: null, district: null, governorate: null };
    }

    return {
      governorateId: hit.governorateId,
      districtId: hit.id,
      district: { id: hit.id, nameEn: hit.nameEn, nameAr: hit.nameAr },
      governorate: hit.governorate,
    };
  }
}
