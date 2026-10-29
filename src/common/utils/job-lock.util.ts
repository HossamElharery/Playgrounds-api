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

function isEngineDisconnected(error: unknown): boolean {
  return (
    error instanceof Error && /Engine is not yet connected/i.test(error.message)
  );
}

export async function withJobLock(
  prisma: Pick<PrismaService, '$queryRaw'>,
  name: string,
  work: () => Promise<void>,
): Promise<boolean> {
  const ownerId = randomUUID();
  if (!(await acquireLease(prisma, name, ownerId))) return false;
  let workFailed = false;
  try {
    await work();
    return true;
  } catch (error) {
    workFailed = true;
    throw error;
  } finally {
    try {
      await releaseLease(prisma, name, ownerId);
    } catch (error) {
      // During a graceful deploy Prisma can disconnect after the cron work finishes but
      // before its best-effort DELETE. The lease already has an expiry, so this is safe.
      // Never let cleanup hide the job's original failure either.
      if (!workFailed && !isEngineDisconnected(error)) throw error;
    }
  }
}
