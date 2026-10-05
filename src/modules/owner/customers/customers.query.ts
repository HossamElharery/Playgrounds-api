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
  /** Games booked (cancelled ones do not count), played or not yet. */
  bookings: number;
  /** Games that really happened: past, not cancelled, not a no-show. */
  visits: number;
  /** The next game booked from now, if any. */
  nextBooking: Date | null;
  /** Money actually earned from this customer: what was received on their bookings. */
  spent: number;
  /** What this customer still owes the venue for games already played. */
  owed: number;
  noShows: number;
  /** The latest game that really happened — a booking for later is not a visit. */
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
  visits: number;
  nextBooking: Date | null;
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
           (COUNT(*) FILTER (WHERE "slotStart" <= (NOW() AT TIME ZONE 'UTC') AND "status" IN ('confirmed', 'completed')))::int AS visits,
           MIN("slotStart") FILTER (WHERE "slotStart" > (NOW() AT TIME ZONE 'UTC') AND "status" IN ('confirmed', 'held')) AS "nextBooking",
           MAX("slotStart") FILTER (WHERE "slotStart" <= (NOW() AT TIME ZONE 'UTC') AND "status" IN ('confirmed', 'completed')) AS "lastVisit",
           MIN("slotStart") FILTER (WHERE "slotStart" <= (NOW() AT TIME ZONE 'UTC') AND "status" IN ('confirmed', 'completed')) AS "firstVisit"
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
  // Keep the original contact name stable: another person's booking on a shared phone must not rename its owner.
  const manualKeys = rows.filter((r) => !r.key.startsWith('p:')).map((r) => r.key);
  const names = new Map<string, string>();
  if (manualKeys.length) {
    const named = await prisma.booking.findMany({
      where: { venueId, source: 'manual', status: { not: 'cancelled' }, AND: [{ guestName: { not: null } }, { guestName: { not: '' } }], guestPhone: { not: null } },
      select: { guestPhone: true, guestName: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      distinct: ['guestPhone'],
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
      visits: r.visits ?? 0,
      nextBooking: r.nextBooking ?? null,
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
      visits: 0,
      nextBooking: null,
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

export interface UnlinkedBookings {
  /** Bookings with neither a name nor a phone: they appear in no customer's file. */
  bookings: number;
  /** What those bookings still owe for games already played — money with nobody to chase. */
  owed: number;
}

/**
 * The bookings a customer list cannot show because nobody wrote down who they were for. They are
 * the reason "15 bookings" can become "2 customers": counted here so the owner can see it and fix it.
 */
export async function queryUnlinkedBookings(prisma: PrismaService, venueId: string): Promise<UnlinkedBookings> {
  const [row] = await prisma.$queryRaw<{ bookings: number; owed: number }[]>(Prisma.sql`
    SELECT COUNT(*)::int AS bookings,
           COALESCE(SUM(CASE WHEN "slotStart" <= (NOW() AT TIME ZONE 'UTC') AND "status" IN ('confirmed', 'completed')
                             THEN GREATEST(0, "totalAmount" - ${Prisma.raw(NET_PAID_SQL)}) ELSE 0 END), 0)::int AS owed
    FROM "Booking"
    WHERE "venueId" = ${venueId}
      AND "source" = 'manual'
      AND "status" <> 'cancelled'
      AND COALESCE("guestPhone", '') = ''
      AND COALESCE("guestName", '') = ''
  `);
  return { bookings: row?.bookings ?? 0, owed: row?.owed ?? 0 };
}
