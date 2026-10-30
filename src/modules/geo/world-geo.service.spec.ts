import { PrismaService } from '../prisma/prisma.service';
import { GeoService } from './geo.service';

describe('GeoService world catalog', () => {
  const countryUpsert = jest.fn();
  const governorateUpsert = jest.fn();
  const districtUpsert = jest.fn();
  const prisma = {
    countryConfig: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: countryUpsert,
    },
    governorate: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: governorateUpsert,
    },
    district: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: districtUpsert,
    },
  } as unknown as PrismaService;

  beforeEach(() => jest.clearAllMocks());

  it('serves Libya with LYD, all regions, and cities on demand', async () => {
    const service = new GeoService(prisma);
    const countries = await service.listCountries();
    const libya = countries.find((country) => country.code === 'LY');
    expect(countries.length).toBeGreaterThanOrEqual(249);
    expect(libya).toMatchObject({ nameAr: 'ليبيا', currency: 'LYD' });

    const regions = await service.listGovernorates('LY');
    const benghazi = regions.find((region) => region.nameEn === 'Benghazi');
    expect(regions.length).toBeGreaterThanOrEqual(20);
    expect(benghazi).toBeDefined();

    const cities = await service.listDistricts(
      benghazi!.id,
      undefined,
      'LY',
      true,
    );
    expect(cities.length).toBeGreaterThan(1);
    expect(cities.at(-1)?.id).toContain('csc-');
  });

  it('materialises a valid catalog selection for venue foreign keys', async () => {
    const service = new GeoService(prisma);
    const regions = await service.listGovernorates('LY');
    const benghazi = regions.find((region) => region.nameEn === 'Benghazi')!;
    const city = (
      await service.listDistricts(benghazi.id, undefined, 'LY', true)
    ).find((item) => item.id.startsWith('csc-city-'))!;

    await service.ensureCatalogLocation('LY', benghazi.id, city.id);

    expect(countryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ code: 'LY', currency: 'LYD' }),
      }),
    );
    expect(governorateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ countryCode: 'LY' }),
      }),
    );
    expect(districtUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ governorateId: benghazi.id }),
      }),
    );
  });
});
