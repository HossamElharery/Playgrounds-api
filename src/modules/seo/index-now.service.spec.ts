import { ConfigService } from '@nestjs/config';
import { IndexNowService } from './index-now.service';

describe('IndexNowService', () => {
  const prisma = { venue: { findUnique: jest.fn() } };
  const values: Record<string, string> = {
    INDEXNOW_KEY: 'test-key', SITE_URL: 'https://mal3ab.app', INDEXNOW_ENDPOINT: 'https://indexnow.test',
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
      'https://mal3ab.app/ar/venues/al-nasr',
      'https://mal3ab.app/en/venues/al-nasr',
    ]);
  });
});
