import type { Prisma } from '@prisma/client';

const GAMING_KINDS = ['gaming-station', 'table-game'];

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
