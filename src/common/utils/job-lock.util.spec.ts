import { withJobLock } from './job-lock.util';

function fakePrisma(locked: boolean) {
  const queryRaw = jest
    .fn()
    .mockResolvedValueOnce(locked ? [{ name: 'x' }] : [])
    .mockResolvedValue([]);
  return { $queryRaw: queryRaw } as any;
}

describe('withJobLock', () => {
  it('runs the job when it gets the lock', async () => {
    const work = jest.fn().mockResolvedValue(undefined);
    await expect(withJobLock(fakePrisma(true), 'x', work)).resolves.toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('skips the job when another instance holds it', async () => {
    const work = jest.fn();
    await expect(withJobLock(fakePrisma(false), 'x', work)).resolves.toBe(
      false,
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('propagates a job failure and releases the lease', async () => {
    await expect(
      withJobLock(fakePrisma(true), 'x', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('does not fail a completed cron while Prisma is disconnecting during deploy', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ name: 'x' }])
        .mockRejectedValueOnce(new Error('Engine is not yet connected.')),
    } as any;

    await expect(withJobLock(prisma, 'x', async () => undefined)).resolves.toBe(
      true,
    );
  });

  it('still reports unexpected lease cleanup failures', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ name: 'x' }])
        .mockRejectedValueOnce(new Error('database unavailable')),
    } as any;

    await expect(
      withJobLock(prisma, 'x', async () => undefined),
    ).rejects.toThrow('database unavailable');
  });

  it('preserves the original job error when releasing the lease also fails', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ name: 'x' }])
        .mockRejectedValueOnce(new Error('release failed')),
    } as any;

    await expect(
      withJobLock(prisma, 'x', async () => {
        throw new Error('job failed');
      }),
    ).rejects.toThrow('job failed');
  });
});
