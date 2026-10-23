import type { PrismaService } from '../prisma/prisma.service';
import type { BookingQualificationService } from './risk/booking-qualification.service';

const LEEWAY_MS = 30 * 60_000;

/**
 * A match someone posted on the platform counts as really played only when a
 * booking at that court, around that time, for one of its players passes the
 * same test as any rewarded booking (checked in by venue staff, made ahead,
 * player is not on the venue's side, venue in good standing). A post alone
 * (the organizer can mark it "played" any time) proves nothing.
 */
export async function matchWasPlayedForReal(
  prisma: Pick<PrismaService, 'booking'>,
  qualification: Pick<BookingQualificationService, 'assess'>,
  post: { courtId: string | null; dateTime: Date },
  playerIds: readonly string[],
): Promise<boolean> {
  if (!post.courtId || !playerIds.length) return false;
  const candidates = await prisma.booking.findMany({
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
    take: 5,
  });
  for (const c of candidates) {
    if ((await qualification.assess(c.id)).ok) return true;
  }
  return false;
}

/** Only photos that look like a real upload count for the review bonus. */
export function realPhotoUrls(photos: readonly string[] | undefined): string[] {
  return (photos ?? []).filter(
    (p) => typeof p === 'string' && p.length <= 600 && /^(https:\/\/|\/uploads\/)/.test(p),
  );
}
