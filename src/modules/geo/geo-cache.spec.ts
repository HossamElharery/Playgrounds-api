import { GeoService } from './geo.service';
import { PrismaService } from '../prisma/prisma.service';

describe('Geo catalog resilience', () => {
  const row = { id: 'd1', slug: 'd1', polygon: null, governorateId: 'g1' };
  let findMany: jest.Mock;
  let service: GeoService;
  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([row]);
    service = new GeoService({ district: { findMany } } as unknown as PrismaService);
  });
  afterEach(() => jest.restoreAllMocks());

  it('shares simultaneous catalog reads and caches successful district results', async () => {
    const values = await Promise.all([service.listDistricts(undefined, undefined, 'EG'), service.listDistricts(undefined, undefined, 'EG')]);
    expect(values[0]).toEqual(values[1]);
    await service.listDistricts(undefined, undefined, 'EG');
    expect(findMany).toHaveBeenCalledTimes(1);
  });
  it('does not cache a failed query and recovers on the next read', async () => {
    findMany.mockRejectedValueOnce(new Error('database offline'));
    await expect(service.listDistricts(undefined, undefined, 'EG')).rejects.toThrow('database offline');
    await expect(service.listDistricts(undefined, undefined, 'EG')).resolves.toHaveLength(1);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
  it('separates filters and refreshes the catalog after the TTL', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    await service.listDistricts(undefined, undefined, 'EG');
    await service.listDistricts('g1', undefined, 'EG');
    expect(findMany).toHaveBeenCalledTimes(2);
    now.mockReturnValue(61_001);
    await service.listDistricts(undefined, undefined, 'EG');
    expect(findMany).toHaveBeenCalledTimes(3);
  });
  it('rejects an unscoped request without accessing the database', async () => {
    await expect(service.listDistricts()).rejects.toThrow('required');
    expect(findMany).not.toHaveBeenCalled();
  });
});
