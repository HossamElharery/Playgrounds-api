import type { Prisma } from '@prisma/client';

const GAMING_KINDS = ['gaming-station', 'table-game'];

/**
 * A venue that runs consoles, billiards or table tennis needs sessions, products and receipts from
 * its first day: approval switches them on so the owner lands on a working hall instead of an
 * empty page asking for an "enable" click. Idempotent, and only ever turns features ON.
 */
export async function activateGamingDefaults(
  tx: Pick<Prisma.TransactionClient, 'venue' | 'venueSport' | 'court'>,
  venueId: string,
): Promise<boolean> {
  const declared =
    (await tx.venueSport.findFirst({ where: { venueId, sport: { activityKind: { in: GAMING_KINDS } } }, select: { venueId: true } })) ||
    (await tx.court.findFirst({ where: { venueId, sport: { activityKind: { in: GAMING_KINDS } } }, select: { id: true } }));
  if (!declared) return false;
  await tx.venue.updateMany({
    where: { id: venueId, OR: [{ gamingSessionsEnabled: false }, { gamingProductsEnabled: false }, { gamingReceiptsEnabled: false }] },
    data: { gamingSessionsEnabled: true, gamingProductsEnabled: true, gamingReceiptsEnabled: true },
  });
  return true;
}
