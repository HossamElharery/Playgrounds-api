import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertVenueAccess } from '../../common/access/owner-access';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import {
  eachYmd,
  resolveOwnerRange,
  type OwnerRangeKey,
} from '../../common/utils/owner-range.util';
import { sourceDisplay } from '../../common/utils/source-label.util';
import {
  hhmmToMinutes,
  type WeeklyHours,
} from '../../common/utils/weekly-hours.util';
import { zonedDayBounds } from '../../common/utils/timezone.util';

/** Prisma predicate: platform booking that counts as collected Matchena revenue. */
export function platformCollectedWhere(): Prisma.BookingWhereInput {
  return {
    source: 'platform',
    NOT: { status: 'cancelled' },
    OR: [
      {
        paymentModeSnapshot: 'online',
        paymentStatus: 'paid',
        status: { in: ['confirmed', 'completed', 'no_show'] },
      },
      {
        OR: [{ paymentModeSnapshot: 'at_venue' }, { paymentModeSnapshot: null }],
        AND: [
          { NOT: { status: 'cancelled' } },
          { OR: [{ status: 'completed' }, { checkedInAt: { not: null } }] },
        ],
      },
    ],
  };
}

export function manualPaidWhere(): Prisma.BookingWhereInput {
  return {
    source: 'manual',
    status: { not: 'cancelled' },
    paymentStatus: 'paid',
  };
}

export function ownerCollectedWhere(): Prisma.BookingWhereInput {
  return { OR: [platformCollectedWhere(), manualPaidWhere()] };
}

/** Keep in lockstep with `platformCollectedWhere()` / `PLATFORM_COLLECTED_SQL`. */
export function matchesPlatformCollected(b: {
  source: string;
  status: string;
  paymentModeSnapshot?: string | null;
  paymentStatus: string;
  checkedInAt?: Date | string | null;
}): boolean {
  if (b.source !== 'platform' || b.status === 'cancelled') return false;
  if (b.paymentModeSnapshot === 'online') {
    return (
      b.paymentStatus === 'paid' &&
      (b.status === 'confirmed' || b.status === 'completed' || b.status === 'no_show')
    );
  }
  return b.status === 'completed' || b.checkedInAt != null;
}

export function matchesManualPaid(b: {
  source: string;
  status: string;
  paymentStatus: string;
}): boolean {
  return b.source === 'manual' && b.status !== 'cancelled' && b.paymentStatus === 'paid';
}

export const PLATFORM_COLLECTED_SQL = `(
  source = 'platform' AND status <> 'cancelled' AND (
    ("paymentModeSnapshot" = 'online' AND "paymentStatus" = 'paid' AND status IN ('confirmed','completed','no_show'))
    OR (
      ("paymentModeSnapshot" = 'at_venue' OR "paymentModeSnapshot" IS NULL)
      AND (status = 'completed' OR "checkedInAt" IS NOT NULL)
    )
  )
)`;

export const MANUAL_PAID_SQL = `(source = 'manual' AND status <> 'cancelled' AND "paymentStatus" = 'paid')`;

export function collectedFromBookings(
  bookings: Array<{
    source: string;
    status: string;
    paymentModeSnapshot?: string | null;
    paymentStatus: string;
    checkedInAt?: Date | string | null;
    baseAmount: number;
    ownerFundedDiscount?: number | null;
    commissionAmount?: number | null;
    totalAmount: number;
  }>,
) {
  let matchenaRevenue = 0;
  let ownRevenue = 0;
  let commission = 0;
  let bookingsCount = 0;
  for (const b of bookings) {
    if (b.status !== 'cancelled') bookingsCount += 1;
    if (matchesPlatformCollected(b)) {
      const gross = Math.max(0, b.baseAmount - (b.ownerFundedDiscount ?? 0));
      matchenaRevenue += gross;
      commission += b.commissionAmount ?? 0;
    } else if (matchesManualPaid(b)) {
      ownRevenue += b.totalAmount;
    }
  }
  const collectedRevenue = matchenaRevenue + ownRevenue;
  return {
    bookings: bookingsCount,
    collectedRevenue,
    matchenaRevenue,
    ownRevenue,
    commission,
    takeHome: collectedRevenue - commission,
  };
}

export function availableMinutesInRange(
  weeklyHours: WeeklyHours | null | undefined,
  fromYmd: string,
  toYmd: string,
  timeZone: string,
): number | null {
  if (!weeklyHours) return null;
  let total = 0;
  for (const ymd of eachYmd(fromYmd, toYmd)) {
    const { dayOfWeek } = zonedDayBounds(ymd, timeZone);
    const day = weeklyHours[String(dayOfWeek)] ?? weeklyHours[dayOfWeek as unknown as string];
    if (!day || day.closed || !day.open || !day.close) continue;
    const open = hhmmToMinutes(day.open);
    const close = hhmmToMinutes(day.close);
    total += close > open ? close - open : 24 * 60 - open + close;
  }
  return total;
}


/** Bookings that count as real reservations (not cancelled, not unpaid holds). */
const COUNTABLE_SQL = Prisma.sql`"status" IN ('confirmed', 'completed', 'no_show')`;
const PLATFORM_SQL = Prisma.sql`"source" = 'platform'`;
const MANUAL_SQL = Prisma.sql`"source" = 'manual'`;

/**
 * Owner revenue of ONE booking, per the money model (00 §4): platform bookings
 * that are collected count `baseAmount − ownerFundedDiscount` (never the player
 * fee); manual bookings count what was paid. Everything else is 0.
 */
const AMOUNT_SQL = Prisma.sql`(CASE
  WHEN ${Prisma.raw(PLATFORM_COLLECTED_SQL)} THEN GREATEST(0, "baseAmount" - "ownerFundedDiscount")
  WHEN ${Prisma.raw(MANUAL_PAID_SQL)} THEN "totalAmount"
  ELSE 0 END)`;

/** Revenue taken as cash: platform at-venue payments and manual cash payments. */
const CASH_SQL = Prisma.sql`(
  ("source" = 'platform' AND COALESCE("paymentModeSnapshot", 'at_venue') = 'at_venue')
  OR ("source" = 'manual' AND COALESCE("paymentMethod", 'cash') = 'cash')
)`;

/**
 * `Booking.slotStart` is `timestamp without time zone` holding UTC. It must be
 * tagged as UTC first, then converted; `ts AT TIME ZONE tz` alone would treat
 * the stored UTC value as local wall-clock time (wrong by the tz offset).
 */
export const localTs = (tz: string): Prisma.Sql =>
  Prisma.sql`(("slotStart" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})`;

/** Venue-local calendar date (YYYY-MM-DD) and time (HH:mm) of a UTC instant. */
export function localDateTime(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const m: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') m[part.type] = part.value;
  return { date: `${m.year}-${m.month}-${m.day}`, time: `${m.hour}:${m.minute}` };
}

/** Hours (0-23) in which the venue is open on at least one day. */
export function openHourSet(weeklyHours: WeeklyHours | null | undefined): Set<number> {
  const all = new Set<number>(Array.from({ length: 24 }, (_, i) => i));
  if (!weeklyHours) return all;
  const hours = new Set<number>();
  for (const day of Object.values(weeklyHours)) {
    if (!day || day.closed || !day.open || !day.close) continue;
    const open = hhmmToMinutes(day.open);
    const close = hhmmToMinutes(day.close);
    const end = close > open ? close : close + 24 * 60;
    for (let m = open; m < end; m += 60) hours.add(Math.floor(m / 60) % 24);
  }
  return hours.size ? hours : all;
}

@Injectable()
export class OwnerSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(
    user: AuthenticatedUser,
    venueId: string,
    rangeKey: string = 'today',
    from?: string,
    to?: string,
  ) {
    const venue = await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const tz =
      (
        await this.prisma.venue.findUnique({
          where: { id: venueId },
          select: { country: { select: { timezone: true } } },
        })
      )?.country?.timezone ?? 'Africa/Cairo';
    const range = resolveOwnerRange(rangeKey as OwnerRangeKey, tz, from, to);
    const inRange: Prisma.BookingWhereInput = {
      venueId,
      slotStart: { gte: range.start, lt: range.end },
    };
    const now = new Date();

    // Every figure below (totals and every breakdown) is derived from the same
    // SQL amount expression (`AMOUNT_SQL`) so the parts always add up to the total.
    const [totalsRow, outstandingRows, expectedAgg, bySourceRows, byUnitRows, byDayRaw, byHourRaw, platCust, manCust, courts] =
      await Promise.all([
        this.totals(venueId, range.start, range.end),
        this.prisma.booking.findMany({
          where: {
            ...inRange,
            source: 'manual',
            status: { not: 'cancelled' },
            paymentStatus: { in: ['pending', 'partial'] },
          },
          select: { id: true, totalAmount: true, payments: { where: { status: 'paid' }, select: { amount: true } } },
        }),
        this.prisma.booking.aggregate({
          where: { venueId, slotStart: { gt: now }, status: 'confirmed' },
          _sum: { totalAmount: true, baseAmount: true, ownerFundedDiscount: true },
        }),
        this.breakdownBySource(venueId, range.start, range.end),
        this.breakdownByUnit(venueId, range.start, range.end),
        this.breakdownByDay(venueId, range.start, range.end, tz),
        this.breakdownByHour(venueId, range.start, range.end, tz),
        this.topPlatformCustomers(venueId, range.start, range.end, venue.ownerId),
        this.topManualCustomers(venueId, range.start, range.end),
        this.prisma.court.findMany({
          where: { venueId },
          select: {
            id: true,
            name: true,
            slotDurationMins: true,
            sport: { select: { activityKind: true } },
          },
        }),
      ]);

    const collectedRevenue = totalsRow.matchena + totalsRow.own;
    const outstanding = outstandingRows.reduce((sum, b) => {
      const paid = b.payments.reduce((p, x) => p + x.amount, 0);
      return sum + Math.max(0, b.totalAmount - paid);
    }, 0);
    const expected = Math.max(
      0,
      (expectedAgg._sum.baseAmount ?? expectedAgg._sum.totalAmount ?? 0) -
        (expectedAgg._sum.ownerFundedDiscount ?? 0),
    );

    const courtMap = new Map(courts.map((c) => [c.id, c]));
    const availableMins = availableMinutesInRange(
      venue.weeklyHours as WeeklyHours | null,
      range.from,
      range.to,
      tz,
    );

    const platUsers = await this.prisma.user.findMany({
      where: { id: { in: platCust.map((p) => p.userId) } },
      select: { id: true, name: true },
    });
    const platUserMap = new Map(platUsers.map((u) => [u.id, u]));
    const topCustomers = [
      ...platCust.map((p) => ({
        key: `p:${p.userId}`,
        name: platUserMap.get(p.userId)?.name ?? null,
        phoneMasked: null as string | null,
        bookings: p.bookings,
        spent: p.revenue,
      })),
      ...manCust.map((m) => ({
        key: `m:${m.guestPhone ?? m.guestName ?? 'unknown'}`,
        name: m.guestName,
        phoneMasked: null as string | null,
        bookings: m.bookings,
        spent: m.revenue,
      })),
    ]
      .sort((a, b) => b.spent - a.spent || b.bookings - a.bookings)
      .slice(0, 5);

    const days = eachYmd(range.from, range.to);
    const byDay = days.map((date) => {
      const hit = byDayRaw.find((r) => r.date === date);
      return hit ?? { date, revenue: 0, bookings: 0 };
    });
    const byHour = Array.from({ length: 24 }, (_, hour) => {
      const hit = byHourRaw.find((r) => r.hour === hour);
      return hit ?? { hour, bookings: 0, revenue: 0 };
    });
    const openHours = openHourSet(venue.weeklyHours as WeeklyHours | null);

    return {
      range: { from: range.from, to: range.to, timezone: tz, key: range.range },
      currency: venue.priceFromCurrency ?? 'EGP',
      totals: {
        bookings: totalsRow.bookings,
        collectedRevenue,
        matchenaRevenue: totalsRow.matchena,
        ownRevenue: totalsRow.own,
        commission: totalsRow.commission,
        takeHome: collectedRevenue - totalsRow.commission,
        outstanding,
        expected,
        cashCollected: totalsRow.cash,
        onlineCollected: collectedRevenue - totalsRow.cash,
      },
      bySource: bySourceRows.map((row) => {
        const display = sourceDisplay(row.source, row.sourceKey, row.sourceLabel);
        return { key: display.key, label: display.label, bookings: row.bookings, revenue: row.revenue };
      }),
      byUnit: byUnitRows.map((row) => {
        const court = courtMap.get(row.courtId);
        const occupancyPct =
          availableMins && availableMins > 0
            ? Math.min(100, Math.round((row.occupied / availableMins) * 100))
            : null;
        return {
          courtId: row.courtId,
          name: court?.name ?? row.courtId,
          sportKind: court?.sport?.activityKind ?? null,
          bookings: row.bookings,
          revenue: row.revenue,
          occupiedMinutes: row.occupied,
          occupancyPct,
        };
      }),
      byDay,
      byHour,
      quietHours: byHour
        .filter((h) => openHours.has(h.hour))
        .sort((a, b) => a.bookings - b.bookings || a.hour - b.hour)
        .slice(0, 5)
        .map((h) => ({
          hour: h.hour,
          freeSlots: Math.max(0, courts.length * days.length - h.bookings),
        })),
      topCustomers,
    };
  }

  async exportCsv(
    user: AuthenticatedUser,
    venueId: string,
    from: string,
    to: string,
  ): Promise<string> {
    const summary = await this.getSummary(user, venueId, 'custom', from, to);
    const range = resolveOwnerRange('custom', summary.range.timezone, from, to);
    const bookings = await this.prisma.booking.findMany({
      where: {
        venueId,
        slotStart: { gte: range.start, lt: range.end },
        status: { not: 'cancelled' },
      },
      include: { court: true, user: { select: { name: true } } },
      orderBy: { slotStart: 'asc' },
    });
    const header = [
      'date',
      'time',
      'unit',
      'source',
      'customer',
      'status',
      'payment status',
      'price',
      'matchena commission',
      'net',
    ];
    const rows = bookings.map((b) => {
      const display = sourceDisplay(b.source, b.sourceKey, b.sourceLabel);
      const commission = b.source === 'platform' ? (b.commissionAmount ?? 0) : 0;
      const net = b.source === 'platform'
        ? (b.ownerNetAmount ?? b.baseAmount - commission)
        : b.totalAmount;
      return this.csvRow([
        localDateTime(b.slotStart, summary.range.timezone).date,
        localDateTime(b.slotStart, summary.range.timezone).time,
        b.court.name,
        display.label,
        b.guestName ?? b.user.name,
        b.status,
        b.paymentStatus,
        // Owner-facing price: what the owner is owed for the slot, never the
        // player-paid total (which includes Matchena's service fee).
        b.source === 'platform'
          ? Math.max(0, b.baseAmount - (b.ownerFundedDiscount ?? 0))
          : b.totalAmount,
        commission,
        net,
      ]);
    });
    return `\uFEFF${header.join(',')}\n${rows.join('\n')}\n# collectedRevenue,${summary.totals.collectedRevenue}\n# commission,${summary.totals.commission}\n# takeHome,${summary.totals.takeHome}\n`;
  }

  csvRow(values: unknown[]): string {
    return values
      .map((value) => {
        const text = String(value ?? '');
        const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
        return `"${safe.replace(/"/g, '""')}"`;
      })
      .join(',');
  }

  // ---- SQL breakdowns (one shared amount + timezone expression) -------------

  private rangeWhere(venueId: string, start: Date, end: Date): Prisma.Sql {
    // `slotStart` is a UTC `timestamp`; bind the bounds as UTC timestamps too so
    // the result never depends on the database session time zone.
    return Prisma.sql`"venueId" = ${venueId}
        AND "slotStart" >= (${start}::timestamptz AT TIME ZONE 'UTC')
        AND "slotStart" < (${end}::timestamptz AT TIME ZONE 'UTC')
        AND ${COUNTABLE_SQL}`;
  }

  private async totals(venueId: string, start: Date, end: Date) {
    const [row] = await this.prisma.$queryRaw<
      { bookings: number; matchena: number; own: number; commission: number; cash: number }[]
    >(Prisma.sql`
      SELECT COUNT(*)::int AS bookings,
             COALESCE(SUM(CASE WHEN ${PLATFORM_SQL} THEN ${AMOUNT_SQL} ELSE 0 END), 0)::int AS matchena,
             COALESCE(SUM(CASE WHEN ${MANUAL_SQL} THEN ${AMOUNT_SQL} ELSE 0 END), 0)::int AS own,
             COALESCE(SUM(CASE WHEN ${Prisma.raw(PLATFORM_COLLECTED_SQL)} THEN COALESCE("commissionAmount", 0) ELSE 0 END), 0)::int AS commission,
             COALESCE(SUM(CASE WHEN ${CASH_SQL} THEN ${AMOUNT_SQL} ELSE 0 END), 0)::int AS cash
      FROM "Booking"
      WHERE ${this.rangeWhere(venueId, start, end)}
    `);
    return row ?? { bookings: 0, matchena: 0, own: 0, commission: 0, cash: 0 };
  }

  private breakdownByDay(venueId: string, start: Date, end: Date, tz: string) {
    return this.prisma.$queryRaw<{ date: string; revenue: number; bookings: number }[]>(Prisma.sql`
      SELECT to_char(${localTs(tz)}::date, 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS bookings,
             COALESCE(SUM(${AMOUNT_SQL}), 0)::int AS revenue
      FROM "Booking"
      WHERE ${this.rangeWhere(venueId, start, end)}
      GROUP BY 1
      ORDER BY 1
    `);
  }

  private breakdownByHour(venueId: string, start: Date, end: Date, tz: string) {
    return this.prisma.$queryRaw<{ hour: number; bookings: number; revenue: number }[]>(Prisma.sql`
      SELECT EXTRACT(HOUR FROM ${localTs(tz)})::int AS hour,
             COUNT(*)::int AS bookings,
             COALESCE(SUM(${AMOUNT_SQL}), 0)::int AS revenue
      FROM "Booking"
      WHERE ${this.rangeWhere(venueId, start, end)}
      GROUP BY 1
      ORDER BY 1
    `);
  }

  private breakdownByUnit(venueId: string, start: Date, end: Date) {
    return this.prisma.$queryRaw<
      { courtId: string; bookings: number; revenue: number; occupied: number }[]
    >(Prisma.sql`
      SELECT "courtId",
             COUNT(*)::int AS bookings,
             COALESCE(SUM(${AMOUNT_SQL}), 0)::int AS revenue,
             COALESCE(SUM(EXTRACT(EPOCH FROM ("slotEnd" - "slotStart")) / 60), 0)::int AS occupied
      FROM "Booking"
      WHERE ${this.rangeWhere(venueId, start, end)}
      GROUP BY 1
      ORDER BY 3 DESC
    `);
  }

  private breakdownBySource(venueId: string, start: Date, end: Date) {
    return this.prisma.$queryRaw<
      { source: 'platform' | 'manual'; sourceKey: string | null; sourceLabel: string | null; bookings: number; revenue: number }[]
    >(Prisma.sql`
      SELECT "source"::text AS source, "sourceKey", "sourceLabel",
             COUNT(*)::int AS bookings,
             COALESCE(SUM(${AMOUNT_SQL}), 0)::int AS revenue
      FROM "Booking"
      WHERE ${this.rangeWhere(venueId, start, end)}
      GROUP BY 1, 2, 3
      ORDER BY 5 DESC
    `);
  }

  private topPlatformCustomers(venueId: string, start: Date, end: Date, ownerId: string) {
    return this.prisma.$queryRaw<{ userId: string; bookings: number; revenue: number }[]>(Prisma.sql`
      SELECT "userId", COUNT(*)::int AS bookings, COALESCE(SUM(${AMOUNT_SQL}), 0)::int AS revenue
      FROM "Booking"
      WHERE ${this.rangeWhere(venueId, start, end)}
        AND ${PLATFORM_SQL}
        AND "userId" <> ${ownerId}
      GROUP BY 1
      ORDER BY 3 DESC, 2 DESC
      LIMIT 5
    `);
  }

  private topManualCustomers(venueId: string, start: Date, end: Date) {
    return this.prisma.$queryRaw<
      { guestName: string | null; guestPhone: string | null; bookings: number; revenue: number }[]
    >(Prisma.sql`
      SELECT "guestName", "guestPhone", COUNT(*)::int AS bookings,
             COALESCE(SUM(${AMOUNT_SQL}), 0)::int AS revenue
      FROM "Booking"
      WHERE ${this.rangeWhere(venueId, start, end)}
        AND ${MANUAL_SQL}
      GROUP BY 1, 2
      ORDER BY 4 DESC, 3 DESC
      LIMIT 5
    `);
  }
}
