import { BadRequestException, ConflictException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiException } from '../../../common/errors/api-exception';
import { assertVenueAccess } from '../../../common/access/owner-access';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { matchPricingRule } from '../../../common/utils/pricing-rule.util';
import { zonedDayBounds, zonedWallTimeToUtc } from '../../../common/utils/timezone.util';
import type { WeeklyHours } from '../../../common/utils/weekly-hours.util';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplyDiscountDto, WindowDto } from './dto/insights.dto';
import {
  buildOccupancyGrid,
  cellStats,
  findIdleWindows,
  suggestedPercent,
  weekdayDips,
  type GridResult,
  type HourSample,
} from './occupancy.util';

const DAY_MS = 86_400_000;
const MIN_DATA_DAYS = 21;
const DISMISS_DAYS = 28;
const WEEKS_PER_MONTH = 52 / 12;
/** How much of the empty time a discount is assumed to fill. Deliberately modest: an estimate, never a promise. */
const CONSERVATIVE_FILL = 0.25;
const OUTCOME_AFTER_DAYS = 14;

const hh = (n: number) => `${String(n).padStart(2, '0')}:00`;

function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

interface Ctx {
  venue: {
    id: string;
    weeklyHours: WeeklyHours | null;
    approvedAt: Date | null;
    createdAt: Date;
    priceFromCurrency: string | null;
  };
  timeZone: string;
  courts: {
    id: string;
    name: string;
    unitKind: string | null;
    rules: {
      id: string;
      daysOfWeek: number[];
      startTime: string;
      endTime: string;
      priceAmount: number;
      currency: string;
      priority: number;
      kind: string;
      validFrom: Date | null;
      validUntil: Date | null;
    }[];
  }[];
}

@Injectable()
export class InsightsService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ read

  /** The occupancy map, the idle windows worth a discount, and how the last weeks compare. */
  async occupancy(user: AuthenticatedUser, venueId: string, weeks = 8) {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const ctx = await this.context(venueId);
    const now = new Date();
    const today = localDate(now, ctx.timeZone);
    const dataSince = await this.dataSince(ctx, venueId);
    const dataDays = Math.max(0, Math.floor((now.getTime() - dataSince.getTime()) / DAY_MS));
    const hasEnoughData = dataDays >= MIN_DATA_DAYS;

    const startDate = [addDays(today, -weeks * 7), localDate(dataSince, ctx.timeZone)].sort().pop()!;
    const dates = startDate < today ? dateRange(startDate, addDays(today, -1)) : [];
    const result = await this.grid(ctx, dates);
    const currency = ctx.venue.priceFromCurrency ?? 'EGP';

    const courts = ctx.courts.map((court) => {
      const cells: (number | null)[][] = [];
      const measured: number[][] = [];
      for (let weekday = 0; weekday < 7; weekday += 1) {
        cells.push([]);
        measured.push([]);
        for (let hour = 0; hour < 24; hour += 1) {
          const stats = cellStats(result.grid[court.id]?.[weekday][hour] ?? []);
          cells[weekday].push(stats.occupancy == null ? null : Math.round(stats.occupancy * 100) / 100);
          measured[weekday].push(stats.days);
        }
      }
      return { courtId: court.id, name: court.name, unitKind: court.unitKind, cells, measured };
    });

    const hidden = await this.hiddenWindows(venueId, now);
    const windows: NonNullable<ReturnType<InsightsService['windowSuggestion']>>[] = [];
    if (hasEnoughData) {
      for (const court of ctx.courts) {
        for (const w of findIdleWindows(result.grid[court.id] ?? [])) {
          if (hidden.some((h) => h.courtId === court.id && h.weekday === w.weekday && overlaps(h.startHour, h.endHour, w.startHour, w.endHour))) continue;
          const suggestion = this.windowSuggestion(ctx, court, w, today);
          if (suggestion) windows.push(suggestion);
        }
      }
    }
    windows.sort((a, b) => b.lostMonthly - a.lostMonthly);

    return {
      venueId,
      timezone: ctx.timeZone,
      currency,
      weeks,
      dataSince: dataSince.toISOString(),
      dataDays,
      hasEnoughData,
      minDataDays: MIN_DATA_DAYS,
      openHours: result.openHours,
      courts,
      windows,
      lostRevenueMonthly: windows.reduce((s, w) => s + w.lostMonthly, 0),
      dips: hasEnoughData ? weekdayDips(result.days) : [],
    };
  }

  /** Discounts applied from here (active and recently ended), each with how the window did since. */
  async listDiscounts(user: AuthenticatedUser, venueId: string) {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const ctx = await this.context(venueId);
    const now = new Date();
    const rows = await this.prisma.pricingDiscount.findMany({
      where: { venueId, status: { in: ['active', 'ended'] }, createdAt: { gte: new Date(now.getTime() - 120 * DAY_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    const items: Record<string, unknown>[] = [];
    for (const d of rows) {
      const court = ctx.courts.find((c) => c.id === d.courtId);
      const running = d.status === 'active' && (!d.validUntil || d.validUntil > now);
      items.push({
        id: d.id,
        courtId: d.courtId,
        courtName: court?.name ?? '',
        weekday: d.weekday,
        startHour: d.startHour,
        endHour: d.endHour,
        percent: d.percent,
        source: d.source,
        status: running ? ('active' as const) : ('ended' as const),
        validFrom: d.validFrom,
        validUntil: d.validUntil,
        daysLeft: running && d.validUntil ? Math.max(0, Math.ceil((d.validUntil.getTime() - now.getTime()) / DAY_MS)) : 0,
        baselineOccupancy: d.baselineOccupancy,
        ...(await this.outcome(ctx, d, now)),
      });
    }
    return { items };
  }

  // ----------------------------------------------------------------- write

  async applyDiscount(user: AuthenticatedUser, dto: ApplyDiscountDto) {
    await assertVenueAccess(this.prisma, user, dto.venueId, { write: true });
    if (dto.endHour <= dto.startHour) throw new BadRequestException('endHour must be after startHour');
    const ctx = await this.context(dto.venueId);
    const court = ctx.courts.find((c) => c.id === dto.courtId);
    if (!court) throw new BadRequestException('Court does not belong to this venue');
    const now = new Date();

    const clash = await this.prisma.pricingDiscount.findFirst({
      where: {
        courtId: dto.courtId,
        weekday: dto.weekday,
        status: 'active',
        OR: [{ validUntil: null }, { validUntil: { gt: now } }],
        startHour: { lt: dto.endHour },
        endHour: { gt: dto.startHour },
      },
      select: { id: true },
    });
    if (clash) throw new ConflictException({ code: 'DISCOUNT_ALREADY_ACTIVE', message: 'That window already has an active discount' });

    const today = localDate(now, ctx.timeZone);
    const reference = this.nextDateOfWeekday(today, dto.weekday);
    const baseRules = court.rules.filter((r) => r.kind !== 'discount');
    const perHour: { hour: number; price: number; currency: string }[] = [];
    for (let hour = dto.startHour; hour < dto.endHour; hour += 1) {
      const at = zonedWallTimeToUtc(reference, hh(hour), ctx.timeZone);
      const rule = baseRules.length ? matchPricingRule(baseRules, dto.weekday, at, ctx.timeZone) : undefined;
      const covers = rule && (rule.daysOfWeek.length === 0 || rule.daysOfWeek.includes(dto.weekday)) && rule.startTime <= hh(hour) && hh(hour) < rule.endTime;
      if (!rule || !covers) {
        throw new ApiException(HttpStatus.BAD_REQUEST, 'NO_BASE_PRICE', 'Set an everyday price for those hours before discounting them');
      }
      perHour.push({ hour, price: rule.priceAmount, currency: rule.currency });
    }
    // One rule per stretch of equal price, so a peak boundary inside the window is respected.
    const segments: { from: number; to: number; price: number; currency: string }[] = [];
    for (const h of perHour) {
      const last = segments[segments.length - 1];
      if (last && last.price === h.price && last.to === h.hour) last.to = h.hour + 1;
      else segments.push({ from: h.hour, to: h.hour + 1, price: h.price, currency: h.currency });
    }

    const baseline = await this.windowOccupancy(ctx, dto.venueId, dto.courtId, dto.weekday, dto.startHour, dto.endHour, now);
    const avgPrice = perHour.reduce((s, h) => s + h.price, 0) / perHour.length;
    const empty = (dto.endHour - dto.startHour) * (1 - (baseline ?? 0)) * WEEKS_PER_MONTH;
    const validUntil = new Date(now.getTime() + dto.weeks * 7 * DAY_MS);
    const priority = Math.max(0, ...court.rules.map((r) => r.priority)) + 10;

    const discount = await this.prisma.$transaction(async (tx) => {
      const ruleIds: string[] = [];
      for (const seg of segments) {
        const rule = await tx.pricingRule.create({
          data: {
            courtId: dto.courtId,
            label: `discount-${dto.percent}%`,
            daysOfWeek: [dto.weekday],
            startTime: hh(seg.from),
            endTime: seg.to === 24 ? '24:00' : hh(seg.to),
            priceAmount: Math.round((seg.price * (100 - dto.percent)) / 100),
            currency: seg.currency,
            priority,
            kind: 'discount',
            source: dto.source ?? 'manual',
            validFrom: now,
            validUntil,
          },
        });
        ruleIds.push(rule.id);
      }
      const row = await tx.pricingDiscount.create({
        data: {
          venueId: dto.venueId,
          courtId: dto.courtId,
          weekday: dto.weekday,
          startHour: dto.startHour,
          endHour: dto.endHour,
          percent: dto.percent,
          status: 'active',
          source: dto.source ?? 'manual',
          validFrom: now,
          validUntil,
          baselineOccupancy: baseline,
          estimatedMonthlyLoss: Math.round(empty * avgPrice),
          ruleIds,
          createdById: user.id,
        },
      });
      await tx.auditLogEntry.create({
        data: {
          actorUserId: user.id,
          action: 'pricing.discount.applied',
          targetType: 'venue',
          targetId: dto.venueId,
          metadata: {
            venueId: dto.venueId,
            courtId: dto.courtId,
            weekday: dto.weekday,
            hours: [dto.startHour, dto.endHour],
            percent: dto.percent,
            weeks: dto.weeks,
            source: dto.source ?? 'manual',
          } as Prisma.InputJsonValue,
        },
      });
      return row;
    });
    return { id: discount.id, validUntil, ruleCount: segments.length };
  }

  /** Ends a discount early: the everyday price is back at once. */
  async endDiscount(user: AuthenticatedUser, id: string) {
    const row = await this.prisma.pricingDiscount.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Discount not found');
    await assertVenueAccess(this.prisma, user, row.venueId, { write: true });
    if (row.status !== 'active') throw new BadRequestException('This discount is not active');
    await this.prisma.$transaction([
      this.prisma.pricingRule.deleteMany({ where: { id: { in: row.ruleIds }, kind: 'discount' } }),
      this.prisma.pricingDiscount.update({ where: { id }, data: { status: 'ended', endedAt: new Date() } }),
      this.prisma.auditLogEntry.create({
        data: {
          actorUserId: user.id,
          action: 'pricing.discount.ended',
          targetType: 'venue',
          targetId: row.venueId,
          metadata: { venueId: row.venueId, discountId: id } as Prisma.InputJsonValue,
        },
      }),
    ]);
    return { ok: true };
  }

  /** "Not now": the suggestion stays hidden for four weeks. */
  async dismiss(user: AuthenticatedUser, dto: WindowDto) {
    await assertVenueAccess(this.prisma, user, dto.venueId, { write: true });
    if (dto.endHour <= dto.startHour) throw new BadRequestException('endHour must be after startHour');
    const court = await this.prisma.court.findUnique({ where: { id: dto.courtId }, select: { venueId: true } });
    if (!court || court.venueId !== dto.venueId) throw new BadRequestException('Court does not belong to this venue');
    await this.prisma.pricingDiscount.create({
      data: {
        venueId: dto.venueId,
        courtId: dto.courtId,
        weekday: dto.weekday,
        startHour: dto.startHour,
        endHour: dto.endHour,
        status: 'dismissed',
        dismissedUntil: new Date(Date.now() + DISMISS_DAYS * DAY_MS),
        createdById: user.id,
      },
    });
    return { ok: true };
  }

  // -------------------------------------------------------------- internals

  private windowSuggestion(
    ctx: Ctx,
    court: Ctx['courts'][number],
    w: { weekday: number; startHour: number; endHour: number; occupancy: number; days: number },
    today: string,
  ) {
    const pct = suggestedPercent(w.occupancy);
    if (pct == null) return null;
    const reference = this.nextDateOfWeekday(today, w.weekday);
    const baseRules = court.rules.filter((r) => r.kind !== 'discount');
    if (!baseRules.length) return null;
    let total = 0;
    for (let hour = w.startHour; hour < w.endHour; hour += 1) {
      const at = zonedWallTimeToUtc(reference, hh(hour), ctx.timeZone);
      const rule = matchPricingRule(baseRules, w.weekday, at, ctx.timeZone);
      if (!(rule.daysOfWeek.length === 0 || rule.daysOfWeek.includes(w.weekday)) || !(rule.startTime <= hh(hour) && hh(hour) < rule.endTime)) return null;
      total += rule.priceAmount;
    }
    const hours = w.endHour - w.startHour;
    const price = Math.round(total / hours);
    const emptyHoursMonthly = hours * (1 - w.occupancy) * WEEKS_PER_MONTH;
    const discounted = Math.round((price * (100 - pct)) / 100);
    return {
      key: `${court.id}:${w.weekday}:${w.startHour}-${w.endHour}`,
      courtId: court.id,
      courtName: court.name,
      weekday: w.weekday,
      startHour: w.startHour,
      endHour: w.endHour,
      occupancy: Math.round(w.occupancy * 100) / 100,
      days: w.days,
      priceAmount: price,
      lostMonthly: Math.round(emptyHoursMonthly * price),
      suggestedPercent: pct,
      discountedPrice: discounted,
      estimatedExtraMonthly: Math.round(emptyHoursMonthly * CONSERVATIVE_FILL * discounted),
      currency: baseRules[0].currency,
    };
  }

  /** Windows that must not be suggested: a discount is running there, or the owner said "not now". */
  private async hiddenWindows(venueId: string, now: Date) {
    const rows = await this.prisma.pricingDiscount.findMany({
      where: {
        venueId,
        OR: [
          { status: 'active', OR: [{ validUntil: null }, { validUntil: { gt: now } }] },
          { status: 'dismissed', dismissedUntil: { gt: now } },
        ],
      },
      select: { courtId: true, weekday: true, startHour: true, endHour: true },
    });
    return rows;
  }

  private async outcome(ctx: Ctx, d: { courtId: string; weekday: number; startHour: number; endHour: number; validFrom: Date | null; validUntil: Date | null; baselineOccupancy: number | null; ruleIds: string[] }, now: Date) {
    if (!d.validFrom || d.baselineOccupancy == null) return { currentOccupancy: null, extraBookedHours: null, extraRevenue: null, measured: false };
    const end = d.validUntil && d.validUntil < now ? d.validUntil : now;
    if (end.getTime() - d.validFrom.getTime() < OUTCOME_AFTER_DAYS * DAY_MS) return { currentOccupancy: null, extraBookedHours: null, extraRevenue: null, measured: false };
    const from = localDate(d.validFrom, ctx.timeZone);
    const to = addDays(localDate(end, ctx.timeZone), -1);
    const dates = from <= to ? dateRange(from, to).filter((date) => zonedDayBounds(date, ctx.timeZone).dayOfWeek === d.weekday) : [];
    if (!dates.length) return { currentOccupancy: null, extraBookedHours: null, extraRevenue: null, measured: false };
    const result = await this.grid(ctx, dates);
    const samples: HourSample[] = [];
    for (let h = d.startHour; h < d.endHour; h += 1) samples.push(...(result.grid[d.courtId]?.[d.weekday][h] ?? []));
    const current = cellStats(samples).occupancy;
    if (current == null) return { currentOccupancy: null, extraBookedHours: null, extraRevenue: null, measured: false };
    const extraHours = (current - d.baselineOccupancy) * (d.endHour - d.startHour) * dates.length;
    const rules = d.ruleIds.length
      ? await this.prisma.pricingRule.findMany({ where: { id: { in: d.ruleIds } }, select: { priceAmount: true } })
      : [];
    const price = rules.length ? rules.reduce((s, r) => s + r.priceAmount, 0) / rules.length : 0;
    return {
      currentOccupancy: Math.round(current * 100) / 100,
      extraBookedHours: Math.round(extraHours * 10) / 10,
      extraRevenue: Math.round(extraHours * price),
      measured: true,
    };
  }

  private async windowOccupancy(ctx: Ctx, venueId: string, courtId: string, weekday: number, startHour: number, endHour: number, now: Date): Promise<number | null> {
    const today = localDate(now, ctx.timeZone);
    const since = await this.dataSince(ctx, venueId);
    const from = [addDays(today, -56), localDate(since, ctx.timeZone)].sort().pop()!;
    const dates = from < today ? dateRange(from, addDays(today, -1)).filter((d) => zonedDayBounds(d, ctx.timeZone).dayOfWeek === weekday) : [];
    if (!dates.length) return null;
    const result = await this.grid(ctx, dates);
    const samples: HourSample[] = [];
    for (let h = startHour; h < endHour; h += 1) samples.push(...(result.grid[courtId]?.[weekday][h] ?? []));
    return cellStats(samples).occupancy;
  }

  private async grid(ctx: Ctx, dates: string[]): Promise<GridResult> {
    if (!dates.length) return { grid: {}, days: [], openHours: { from: 6, to: 24 } };
    const sorted = [...dates].sort();
    const rangeStart = zonedWallTimeToUtc(sorted[0], '00:00', ctx.timeZone);
    const rangeEnd = zonedWallTimeToUtc(addDays(sorted[sorted.length - 1], 1), '00:00', ctx.timeZone);
    const courtIds = ctx.courts.map((c) => c.id);
    const [bookings, blocks] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          venueId: ctx.venue.id,
          courtId: { in: courtIds },
          // A no-show still kept the slot away from everyone else, so it counts as occupied.
          status: { in: ['confirmed', 'completed', 'no_show'] },
          slotStart: { lt: rangeEnd },
          slotEnd: { gt: rangeStart },
        },
        select: { courtId: true, slotStart: true, slotEnd: true },
      }),
      this.prisma.calendarBlock.findMany({
        where: { venueId: ctx.venue.id, startsAt: { lt: rangeEnd }, endsAt: { gt: rangeStart } },
        select: { courtId: true, startsAt: true, endsAt: true },
      }),
    ]);
    return buildOccupancyGrid({
      timeZone: ctx.timeZone,
      dates: sorted,
      weeklyHours: ctx.venue.weeklyHours,
      courtIds,
      bookings,
      blocks,
    });
  }

  private async context(venueId: string): Promise<Ctx> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: {
        id: true,
        weeklyHours: true,
        approvedAt: true,
        createdAt: true,
        priceFromCurrency: true,
        country: { select: { timezone: true } },
        courts: {
          select: {
            id: true,
            name: true,
            sport: { select: { activityKind: true } },
            pricingRules: true,
          },
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    return {
      venue: {
        id: venue.id,
        weeklyHours: (venue.weeklyHours as WeeklyHours | null) ?? null,
        approvedAt: venue.approvedAt,
        createdAt: venue.createdAt,
        priceFromCurrency: venue.priceFromCurrency,
      },
      timeZone: venue.country?.timezone ?? 'Africa/Cairo',
      courts: venue.courts.map((c) => ({
        id: c.id,
        name: c.name,
        unitKind: c.sport?.activityKind ?? null,
        rules: c.pricingRules,
      })),
    };
  }

  /** Measuring starts when the venue went live, or with its first booking — never before, or it would read as "empty". */
  private async dataSince(ctx: Ctx, venueId: string): Promise<Date> {
    const first = await this.prisma.booking.findFirst({
      where: { venueId, status: { in: ['confirmed', 'completed', 'no_show'] } },
      orderBy: { slotStart: 'asc' },
      select: { slotStart: true },
    });
    const live = ctx.venue.approvedAt ?? ctx.venue.createdAt;
    return first && first.slotStart < live ? first.slotStart : live;
  }

  private nextDateOfWeekday(today: string, weekday: number): string {
    for (let i = 1; i <= 7; i += 1) {
      const d = addDays(today, i);
      if (new Date(`${d}T12:00:00Z`).getUTCDay() === weekday) return d;
    }
    return addDays(today, 1);
  }
}
