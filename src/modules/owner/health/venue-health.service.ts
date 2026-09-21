import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { subscriptionStanding } from '../../subscriptions/subscription-state.util';
import { availableMinutesInRange } from '../owner-summary.service';
import { QuickstartService } from '../quickstart/quickstart.service';
import { addDays, zonedDate } from '../../../common/utils/fixed-series.util';
import type { WeeklyHours } from '../../../common/utils/weekly-hours.util';

const DAY_MS = 86_400_000;
/** No booking created for this long = "quiet". */
const QUIET_DAYS = 14;

/** One row per venue for the admin: who is active, who is stuck, who needs a call. Only existing data. */
@Injectable()
export class VenueHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quickstart: QuickstartService,
  ) {}

  async board(now: Date = new Date()) {
    const since = new Date(now.getTime() - 30 * DAY_MS);
    const venues = await this.prisma.venue.findMany({
      where: { isDemo: false },
      select: {
        id: true, nameEn: true, nameAr: true, ownerId: true, weeklyHours: true, status: true,
        country: { select: { timezone: true } },
        owner: { select: { name: true, lastSeenAt: true } },
        _count: { select: { courts: true } },
      },
    });
    const ids = venues.map((v) => v.id);

    const [agg, lastCreated, subs, openRequests] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ['venueId', 'source'],
        where: { venueId: { in: ids }, status: { not: 'cancelled' }, slotStart: { gte: since, lt: now } },
        _count: { _all: true },
      }),
      this.prisma.booking.groupBy({ by: ['venueId'], where: { venueId: { in: ids } }, _max: { createdAt: true } }),
      this.prisma.venueSubscription.findMany({ where: { venueId: { in: ids } } }),
      this.prisma.platformBookingRequest.groupBy({ by: ['venueId'], where: { status: 'open', venueId: { in: ids } }, _count: { _all: true } }),
    ]);
    // Booked minutes in the window, in one query.
    const minutes = ids.length
      ? await this.prisma.$queryRaw<{ venueId: string; mins: number }[]>`
          SELECT "venueId", COALESCE(SUM(EXTRACT(EPOCH FROM ("slotEnd" - "slotStart")) / 60), 0)::float AS mins
          FROM "Booking"
          WHERE "venueId" = ANY(${ids}) AND status IN ('confirmed','completed','no_show')
            AND "slotStart" >= ${since} AND "slotStart" < ${now}
          GROUP BY "venueId"`
      : [];

    const rows = await Promise.all(
      venues.map(async (v) => {
        const tz = v.country?.timezone ?? 'Africa/Cairo';
        const counts = { platform: 0, manual: 0 };
        for (const a of agg) if (a.venueId === v.id) counts[a.source] += a._count._all;
        const created = lastCreated.find((l) => l.venueId === v.id)?._max.createdAt ?? null;
        const sub = subs.find((s) => s.venueId === v.id);
        const standing = sub ? subscriptionStanding(sub, now) : null;
        const today = zonedDate(now, tz);
        const available = availableMinutesInRange(v.weeklyHours as WeeklyHours | null, addDays(today, -30), today, tz);
        const booked = minutes.find((m) => m.venueId === v.id)?.mins ?? 0;
        const occupancyPct = available && v._count.courts ? Math.min(100, Math.round((booked / (available * v._count.courts)) * 100)) : null;
        const qs = await this.quickstart.compute(v.id, v.ownerId, v.weeklyHours as WeeklyHours | null);
        const team = await this.prisma.staffMember.count({ where: { ownerId: v.ownerId } });
        return {
          venueId: v.id,
          nameEn: v.nameEn,
          nameAr: v.nameAr,
          ownerName: v.owner.name,
          status: v.status,
          lastBookingCreatedAt: created?.toISOString() ?? null,
          ownerLastSeenAt: v.owner.lastSeenAt?.toISOString() ?? null,
          occupancyPct30: occupancyPct,
          platformBookings30: counts.platform,
          manualBookings30: counts.manual,
          subscription: standing ? { state: standing.state, daysLeft: standing.daysLeft } : null,
          quickstartDone: qs.complete,
          quickstartMissing: qs.steps.filter((s) => !s.done && !s.optional).map((s) => s.key),
          teamSize: team,
          openRequests: openRequests.find((o) => o.venueId === v.id)?._count._all ?? 0,
          quiet: !created || now.getTime() - created.getTime() > QUIET_DAYS * DAY_MS,
          // Typing their own bookings in = actually using it as a management tool.
          usesManualBookings: counts.manual > 0,
        };
      }),
    );
    return { generatedAt: now.toISOString(), quietAfterDays: QUIET_DAYS, items: rows };
  }
}
