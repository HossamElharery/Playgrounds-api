import type { Prisma } from '@prisma/client';

/**
 * Serialises the "is this time free?" decision for one venue.
 *
 * The exclusion constraints already make double booking impossible; this lock makes the
 * decision *atomic with the things the constraints cannot see*, such as a calendar block
 * being created at the same moment a player holds a slot inside it. It is held until the
 * transaction ends and costs milliseconds, and only players/owners of the same venue wait.
 *
 * It must be the FIRST statement of a READ COMMITTED transaction: in REPEATABLE READ /
 * SERIALIZABLE the snapshot would be taken before waiting and would then be stale.
 */
export async function lockVenueSlots(tx: Prisma.TransactionClient, venueId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`slots:${venueId}`}, 0))::text`;
}
