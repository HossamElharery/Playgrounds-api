import {
  beginShutdownDrain,
  resetShutdownDrainForTests,
} from '../../common/lifecycle/shutdown-state';
import { AppService } from './app.service';

describe('AppService readiness during shutdown', () => {
  afterEach(resetShutdownDrainForTests);

  it('becomes unready immediately when draining starts', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockResolvedValueOnce([{ n: 0 }]),
    };
    const service = new AppService(prisma as never);

    await expect(service.ready()).resolves.toMatchObject({ status: 'ready' });
    beginShutdownDrain();
    await expect(service.ready()).resolves.toEqual({
      status: 'draining',
      unfinishedMigrations: 0,
      dbMs: 0,
    });
    expect(service.health().status).toBe('draining');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
