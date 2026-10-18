import type { PrismaService } from '../../modules/prisma/prisma.service';

const MAX_JOB_MS = 10 * 60_000;

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
