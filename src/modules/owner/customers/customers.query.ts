import { Prisma } from '@prisma/client';
import { maskPlayerPhone } from '../../../common/utils/phone.util';
import { sourceDisplay } from '../../../common/utils/source-label.util';
import { PrismaService } from '../../prisma/prisma.service';
import { AMOUNT_SQL, NET_PAID_SQL } from '../owner-summary.service';

export interface OwnerCustomerItem {
  key: string;
  name: string | null;
  phone: string | null;
  phoneMasked: string | null;
  /** Games booked (cancelled ones do not count). */
  bookings: number;
  /** Money actually earned from this customer: what was received on their bookings. */
  spent: number;
  /** What this customer still owes the venue for games already played. */
  owed: number;
  noShows: number;
  lastVisit: Date | null;
  firstVisit: Date | null;
  sources: string[];
  isMatchenaPlayer: boolean;
  note: string | null;
  imported: boolean;
}

interface Row {
  key: string;
  bookings: number;
  noShows: number;
  spent: number;
  owed: number;
  lastVisit: Date | null;
  firstVisit: Date | null;
}

/**
 * The venue's people: everyone who booked (Matchena players and the venue's own callers) plus
 * anyone imported or annotated. "Spent" is money received, not the price of the bookings — a
 * no-show who never paid is not a good customer — and "owed" is what is still unpaid for games
 * that already happened.
 */
export async function queryCustomers(prisma: PrismaService, venueId: string, ownerId: string): Promise<OwnerCustomerItem[]> {
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    WITH b AS (
      SELECT "source", "status", "slotStart",
             (CASE WHEN "source" = 'platform' THEN 'p:' || "userId"
                   WHEN COALESCE("guestPhone", '') <> '' THEN 'm:' || "guestPhone"
                   WHEN COALESCE("guestName", '') <> '' THEN 'n:' || "guestName"
                   ELSE NULL END) AS key,
             ${AMOUNT_SQL} AS revenue,
             (CASE WHEN "source" = 'manual' AND "slotStart" <= (NOW() AT TIME ZONE 'UTC')
                   THEN GREATEST(0, "totalAmount" - ${Prisma.raw(NET_PAID_SQL)}) ELSE 0 END) AS owes
      FROM "Booking"
      WHERE "venueId" = ${venueId}
        AND "status" <> 'cancelled'
        AND NOT ("source" = 'platform' AND "userId" = ${ownerId})
    )
    SELECT key,
           COUNT(*)::int AS bookings,
           (COUNT(*) FILTER (WHERE "status" = 'no_show'))::int AS "noShows",
           COALESCE(SUM(revenue), 0)::int AS spent,
           COALESCE(SUM(owes) FILTER (WHERE "status" IN ('confirmed', 'completed')), 0)::int AS owed,
           MAX("slotStart") AS "lastVisit",
           MIN("slotStart") AS "firstVisit"
    FROM b
    WHERE key IS NOT NULL
    GROUP BY key
  `);

  const platformIds = rows.filter((r) => r.key.startsWith('p:')).map((r) => r.key.slice(2));
  const [users, sourceRows, profiles] = await Promise.all([
    platformIds.length
      ? prisma.user.findMany({ where: { id: { in: platformIds } }, select: { id: true, name: true, phone: true } })
      : Promise.resolve([] as { id: string; name: string | null; phone: string | null }[]),
    prisma.booking.groupBy({
      by: ['userId', 'source', 'sourceKey', 'sourceLabel', 'guestPhone', 'guestName'],
      where: { venueId, status: { not: 'cancelled' } },
      _count: { _all: true },
    }),
    prisma.venueCustomer.findMany({ where: { venueId } }),
  ]);
  const userMap = new Map(users.map((u) => [u.id, u]));
  const profileMap = new Map(profiles.map((p) => [p.key, p]));
  const sources = new Map<string, Set<string>>();
  for (const s of sourceRows) {
    const key = s.source === 'platform' ? `p:${s.userId}` : s.guestPhone ? `m:${s.guestPhone}` : s.guestName ? `n:${s.guestName}` : null;
    if (!key) continue;
    (sources.get(key) ?? sources.set(key, new Set()).get(key)!).add(sourceDisplay(s.source, s.sourceKey, s.sourceLabel).label);
  }
  // A display name for the venue's own callers: the latest one typed on a booking with that key.
  const manualKeys = rows.filter((r) => !r.key.startsWith('p:')).map((r) => r.key);
  const names = new Map<string, string>();
  if (manualKeys.length) {
    const named = await prisma.booking.findMany({
      where: { venueId, source: 'manual', status: { not: 'cancelled' }, guestName: { not: null }, guestPhone: { not: null } },
      select: { guestPhone: true, guestName: true },
      orderBy: { slotStart: 'desc' },
      take: 5000,
    });
    for (const n of named) if (n.guestPhone && n.guestName && !names.has(`m:${n.guestPhone}`)) names.set(`m:${n.guestPhone}`, n.guestName);
  }

  const seen = new Set<string>();
  const items: OwnerCustomerItem[] = rows.map((r) => {
    seen.add(r.key);
    const platform = r.key.startsWith('p:');
    const u = platform ? userMap.get(r.key.slice(2)) : undefined;
    const profile = profileMap.get(r.key);
    const rawName = r.key.startsWith('n:') ? r.key.slice(2) : (names.get(r.key) ?? null);
    return {
      key: r.key,
      name: platform ? (u?.name ?? null) : (profile?.name ?? rawName),
      phone: r.key.startsWith('m:') ? r.key.slice(2) : null,
      phoneMasked: platform ? maskPlayerPhone(u?.phone) : null,
      bookings: r.bookings,
      spent: r.spent,
      owed: r.owed,
      noShows: r.noShows,
      lastVisit: r.lastVisit,
      firstVisit: r.firstVisit,
      sources: [...(sources.get(r.key) ?? [])],
      isMatchenaPlayer: platform,
      note: profile?.note ?? null,
      imported: profile?.imported ?? false,
    };
  });
  // People who were imported (or annotated) but have not booked yet.
  for (const p of profiles) {
    if (seen.has(p.key)) continue;
    items.push({
      key: p.key,
      name: p.name,
      phone: p.phone,
      phoneMasked: null,
      bookings: 0,
      spent: 0,
      owed: 0,
      noShows: 0,
      lastVisit: null,
      firstVisit: null,
      sources: [],
      isMatchenaPlayer: false,
      note: p.note,
      imported: p.imported,
    });
  }
  return items.sort(
    (a, b) => b.bookings - a.bookings || (b.lastVisit?.getTime() ?? 0) - (a.lastVisit?.getTime() ?? 0),
  );
}
