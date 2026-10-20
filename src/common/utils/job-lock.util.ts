import type { PrismaService } from '../../modules/prisma/prisma.service';
import { randomUUID } from 'node:crypto';

const MAX_JOB_MS = 10 * 60_000;
const LEASE_MS = MAX_JOB_MS + 60_000;

/**
 * Acquire a lease without keeping a database transaction open while the job
 * runs. The previous advisory-transaction lock held one Prisma connection for
 * the entire job, which allowed overlapping cron jobs to exhaust the pool.
 */
async function acquireLease(
  prisma: Pick<PrismaService, '$queryRaw'>,
  name: string,
  ownerId: string,
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + LEASE_MS);
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    INSERT INTO "JobLease" ("name", "ownerId", "expiresAt", "updatedAt")
    VALUES (${name}, ${ownerId}, ${expiresAt}, NOW())
    ON CONFLICT ("name") DO UPDATE
      SET "ownerId" = EXCLUDED."ownerId",
          "expiresAt" = EXCLUDED."expiresAt",
          "updatedAt" = NOW()
      WHERE "JobLease"."expiresAt" <= NOW()
    RETURNING "name"`;
  return rows.length === 1;
}

async function releaseLease(
  prisma: Pick<PrismaService, '$queryRaw'>,
  name: string,
  ownerId: string,
): Promise<void> {
  await prisma.$queryRaw`
    DELETE FROM "JobLease"
    WHERE "name" = ${name} AND "ownerId" = ${ownerId}`;
}

export async function withJobLock(
  prisma: Pick<PrismaService, '$queryRaw'>,
  name: string,
  work: () => Promise<void>,
): Promise<boolean> {
  const ownerId = randomUUID();
  if (!(await acquireLease(prisma, name, ownerId))) return false;
  try {
    await work();
    return true;
  } finally {
    await releaseLease(prisma, name, ownerId);
  }
}
