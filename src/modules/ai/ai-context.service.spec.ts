import { AiContextService } from './ai-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeoService } from '../geo/geo.service';

function makeService() {
  const prisma = {
    sportCategory: {
      findMany: jest.fn().mockResolvedValue([{ slug: 'padel', nameAr: 'بادل', nameEn: 'Padel' }]),
    },
    court: {
      findMany: jest.fn().mockResolvedValue([{ name: 'Court 1' }, { name: 'Court 2' }]),
    },
  } as unknown as PrismaService;
  const geo = {
    listDistricts: jest
      .fn()
      .mockResolvedValue([{ slug: 'zamalek', nameAr: 'الزمالك', nameEn: 'Zamalek' }]),
  } as unknown as GeoService;
  return new AiContextService(prisma, geo);
}

describe('AiContextService', () => {
  it('includes real sport and district names from the database', async () => {
    const context = await makeService().buildPlatformContext();
    expect(context).toContain('padel');
    expect(context).toContain('بادل');
    expect(context).toContain('zamalek');
    expect(context).toContain('الزمالك');
  });

  it('includes the local synonym list', async () => {
    const context = await makeService().buildPlatformContext();
    expect(context).toContain('خماسي');
    expect(context).toContain('5-a-side');
  });

  it('caches the platform context instead of re-querying every call', async () => {
    const service = makeService();
    await service.buildPlatformContext();
    await service.buildPlatformContext();
    expect((service as any).prisma.sportCategory.findMany).toHaveBeenCalledTimes(1);
  });

  it('builds a venue-specific context from real court names', async () => {
    const service = makeService();
    const context = await service.buildVenueContext('venue-1');
    expect(context).toContain('Court 1');
    expect(context).toContain('Court 2');
  });

  it('exposes the real slugs for validating the model output', async () => {
    const service = makeService();
    const { sports, districts } = await service.listValidSlugs();
    expect(sports.has('padel')).toBe(true);
    expect(sports.has('made-up-sport')).toBe(false);
    expect(districts.has('zamalek')).toBe(true);
  });
});
