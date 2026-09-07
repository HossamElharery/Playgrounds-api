import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeCountryCode } from '../../common/geo/country.util';
import { toSearchBoundary } from '../../common/utils/geo.util';

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
}
