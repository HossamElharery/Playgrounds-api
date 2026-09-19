import { ConfigService } from '@nestjs/config';
import { IndexNowService } from './index-now.service';

describe('IndexNowService', () => {
  const prisma = { venue: { findUnique: jest.fn(), findMany: jest.fn() } };
  const values: Record<string, string> = {
    INDEXNOW_KEY: 'test-key', SITE_URL: 'https://matchena.com', INDEXNOW_ENDPOINT: 'https://indexnow.test',
  };
  const config = { get: (key: string) => values[key] } as ConfigService;
  const originalFetch = global.fetch;

  afterEach(() => { global.fetch = originalFetch; jest.clearAllMocks(); });

  it('submits both locale URLs for a changed venue', async () => {
    prisma.venue.findUnique.mockResolvedValue({ slug: 'al-nasr' });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as jest.Mock;
    const service = new IndexNowService(config, prisma as never);
    await service.notifyVenueById('v1');
    const request = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(request[1].body);
    expect(body.urlList).toEqual([
      'https://matchena.com/ar/venues/al-nasr',
      'https://matchena.com/en/venues/al-nasr',
    ]);
  });

  it('does not poll the database when IndexNow is not configured', async () => {
    const empty = { get: () => '' } as unknown as ConfigService;
    const service = new IndexNowService(empty, prisma as never);
    await expect(service.notifyRecentlyChangedVenues()).resolves.toBeUndefined();
    expect(prisma.venue.findMany).not.toHaveBeenCalled();
  });

  it('swallows a down database instead of throwing into the scheduler', async () => {
    prisma.venue.findMany.mockRejectedValue(new Error("Can't reach database server at localhost:5432"));
    const service = new IndexNowService(config, prisma as never);
    await expect(service.notifyRecentlyChangedVenues()).resolves.toBeUndefined();
  });
});
