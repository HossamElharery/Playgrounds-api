import type { PrismaService } from '../prisma/prisma.service';

const LEEWAY_MS = 30 * 60_000;

/**
 * A match someone posted on the platform counts as really played only when a
 * venue's staff checked in a booking for one of its players on that court at
 * about that time. A post alone (the organizer can mark it "played" any time)
 * proves nothing.
 */
export async function matchWasPlayedForReal(
  prisma: Pick<PrismaService, 'booking'>,
  post: { courtId: string | null; dateTime: Date },
  playerIds: readonly string[],
): Promise<boolean> {
  if (!post.courtId || !playerIds.length) return false;
  const found = await prisma.booking.findFirst({
    where: {
      courtId: post.courtId,
      status: 'completed',
      source: 'platform',
      checkedInAt: { not: null },
      userId: { in: [...playerIds] },
      slotStart: { lte: new Date(post.dateTime.getTime() + LEEWAY_MS) },
      slotEnd: { gte: new Date(post.dateTime.getTime() - LEEWAY_MS) },
    },
    select: { id: true },
  });
  return !!found;
}

/** Only photos that look like a real upload count for the review bonus. */
export function realPhotoUrls(photos: readonly string[] | undefined): string[] {
  return (photos ?? []).filter(
    (p) => typeof p === 'string' && p.length <= 600 && /^(https:\/\/|\/uploads\/)/.test(p),
  );
}
