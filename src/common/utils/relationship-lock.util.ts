import { Prisma } from '@prisma/client';
import { PrismaService } from '../../modules/prisma/prisma.service';

/** Serialize both directions of a relationship, including requests and blocks. */
export function withRelationshipLock<T>(
  prisma: PrismaService,
  a: string,
  b: string,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([a, b].sort());
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    return action(tx);
  });
}
