import { withJobLock } from './job-lock.util';

function fakePrisma(locked: boolean) {
  const tx = { $queryRaw: jest.fn().mockResolvedValue([{ locked }]) };
  return { $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) } as any;
}

describe('withJobLock', () => {
  it('runs the job when it gets the lock', async () => {
    const work = jest.fn().mockResolvedValue(undefined);
    await expect(withJobLock(fakePrisma(true), 'x', work)).resolves.toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('skips the job when another instance holds it', async () => {
    const work = jest.fn();
    await expect(withJobLock(fakePrisma(false), 'x', work)).resolves.toBe(false);
    expect(work).not.toHaveBeenCalled();
  });

  it('propagates a job failure (so the lock transaction rolls back)', async () => {
    await expect(withJobLock(fakePrisma(true), 'x', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
