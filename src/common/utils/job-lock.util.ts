import type { PrismaService } from '../../modules/prisma/prisma.service';

/** Longest a single job may hold its lock; the transaction (and lock) ends on its own after this. */
const MAX_JOB_MS = 10 * 60_000;

/**
 * Runs `work` only if no other app instance is running the same job right now.
 *
 * With several replicas every `@Cron` fires on all of them, so reminders and
 * horizon extensions would run N times. A transaction-scoped Postgres advisory
 * lock is held for the duration of the job: it is released automatically on
 * commit/rollback or if the process dies, so a crashed instance can never leave a
 * job stuck. Returns false when another instance holds the lock (job skipped).
 */
export async function withJobLock(
  prisma: Pick<PrismaService, '$transaction'>,
  name: string,
  work: () => Promise<void>,
): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`cron:${name}`}, 0)) AS locked`;
      if (!rows[0]?.locked) return false;
      await work();
      return true;
    },
    { timeout: MAX_JOB_MS, maxWait: 5_000 },
  );
}
