import { BadRequestException, ConflictException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, RecurringBookingSeries } from '@prisma/client';
import { withJobLock } from '../../../common/utils/job-lock.util';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { LedgerService } from '../../finance/ledger.service';
import { OwnerBookingsService } from '../owner-bookings.service';
import { ApiException } from '../../../common/errors/api-exception';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { assertVenueAccess } from '../../../common/access/owner-access';
import { isBookingSlotConflict } from '../../../common/utils/booking-slot-conflict.util';
import { isPastSlotStart } from '../../../common/utils/past-slot.util';
import { quoteDurationPrice } from '../../../common/utils/price-quote.util';
import {
  addDays,
  FIXED_HORIZON_WEEKS,
  isLocalDate,
  seriesDates,
  sessionWindow,
  weekdayOfLocalDate,
  zonedDate,
} from '../../../common/utils/fixed-series.util';
import { zonedHhmm } from '../../../common/utils/timezone.util';
import {
  CreateFixedSeriesDto,
  FixedSeriesShapeDto,
  RescheduleSeriesDto,
} from './fixed-bookings.dto';

type Conflict = 'SLOT_ALREADY_HELD' | 'SLOT_BLOCKED';

export interface PreviewSession {
  date: string;
  startsAt: string;
  endsAt: string;
  priceAmount: number | null;
  conflict: Conflict | 'SLOT_IN_PAST' | null;
  /** Booked now (inside the horizon) vs. generated later by the daily job. */
  bookedNow: boolean;
  skipped: boolean;
}

interface ResolvedShape {
  court: CourtCtx;
  weekday: number;
  startDate: string;
  startTime: string;
  until: string;
  durationMins: number;
  priceAmount: number | null;
}

interface CourtCtx {
  id: string;
  venueId: string;
  timeZone: string;
  pricingRules: Prisma.PricingRuleGetPayload<object>[];
}

@Injectable()
export class FixedBookingsService {
  private readonly logger = new Logger(FixedBookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerBookings: OwnerBookingsService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---- preview / create ---------------------------------------------------

  async preview(user: AuthenticatedUser, dto: FixedSeriesShapeDto) {
    await assertVenueAccess(this.prisma, user, dto.venueId, { write: false });
    const shape = await this.resolveShape(dto);
    const sessions = await this.buildSessions(shape, dto.skipDates ?? []);
    return {
      weekday: shape.weekday,
      startTime: shape.startTime,
      startDate: shape.startDate,
      until: shape.until,
      sessions,
      conflicts: sessions.filter((s) => s.conflict && !s.skipped).map((s) => s.date),
    };
  }

  async create(user: AuthenticatedUser, dto: CreateFixedSeriesDto) {
    await assertVenueAccess(this.prisma, user, dto.venueId, { write: true });
    const plan = dto.paymentPlan ?? 'per_session';
    if (plan === 'prepaid' && !dto.prepaidAmount) {
      throw new BadRequestException('prepaidAmount is required for a prepaid plan');
    }
    const shape = await this.resolveShape(dto);
    const sessions = await this.buildSessions(shape, dto.skipDates ?? []);
    if (!sessions.some((s) => !s.skipped && s.conflict !== 'SLOT_IN_PAST')) {
      throw new BadRequestException('Nothing left to book after skipping');
    }
    if (sessions[0].conflict === 'SLOT_IN_PAST' && !sessions[0].skipped) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'SLOT_IN_PAST', 'This time has already passed and cannot be booked');
    }

    if (dto.priceAmount == null && sessions.some((s) => !s.skipped && s.priceAmount == null)) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'PRICE_REQUIRED', 'No price is set for that time — enter one');
    }

    const series = await this.prisma.recurringBookingSeries.create({
      data: {
        courtId: dto.courtId,
        venueId: dto.venueId,
        kind: 'manual',
        dayOfWeek: shape.weekday,
        startTime: shape.startTime,
        durationMins: dto.durationMinutes,
        customerName: dto.customerName.trim(),
        customerPhone: dto.customerPhone?.trim() || null,
        paymentPlan: plan,
        priceAmount: dto.priceAmount ?? null,
        startDate: shape.startDate,
        until: shape.until,
        skippedDates: (dto.skipDates ?? []).filter((d) => sessions.some((s) => s.date === d)),
        sourceKey: dto.sourceLabel ? null : (dto.sourceKey ?? 'phone'),
        sourceLabel: dto.sourceLabel?.trim() || null,
        notes: dto.notes?.trim() || null,
        createdByUserId: user.id,
      },
    });

    const result = await this.fillHorizon(series, shape.court, {
      actorId: user.id,
      prepaid: plan === 'prepaid' ? { amount: dto.prepaidAmount!, method: dto.paymentMethod } : undefined,
    });
    await this.recordConflicts(series.id, result.conflicts);
    return { ...(await this.toDto(series.id)), created: result.created, conflicts: result.conflicts };
  }

  // ---- list ---------------------------------------------------------------

  async list(user: AuthenticatedUser, venueId: string) {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const tz = await this.venueTz(venueId);
    const today = zonedDate(new Date(), tz);
    const rows = await this.prisma.recurringBookingSeries.findMany({
      where: {
        venueId,
        kind: 'manual',
        status: 'active',
        OR: [{ until: null }, { until: { gte: today } }],
      },
      orderBy: { createdAt: 'desc' },
      include: { court: { select: { id: true, name: true } } },
    });
    const now = new Date();
    return Promise.all(
      rows.map(async (row) => {
        const upcoming = await this.prisma.booking.findMany({
          where: {
            recurringSeriesId: row.id,
            status: { in: ['held', 'confirmed'] },
            slotStart: { gte: now },
          },
          orderBy: { slotStart: 'asc' },
          select: { slotStart: true },
        });
        return {
          ...this.mapSeries(row),
          court: row.court,
          nextStartsAt: upcoming[0]?.slotStart.toISOString() ?? null,
          remaining: upcoming.length,
        };
      }),
    );
  }

  // ---- actions ------------------------------------------------------------

  /** Leave one date out: cancels that session and makes sure the job never books it again. */
  async skipDate(user: AuthenticatedUser, seriesId: string, date: string) {
    const series = await this.loadWritable(user, seriesId);
    const tz = await this.venueTz(series.venueId!);
    this.assertOccurrence(series, date);
    this.assertNotPast(date, series.startTime, tz);
    if (!series.skippedDates.includes(date)) {
      await this.prisma.$transaction(async (tx) => {
        await tx.recurringBookingSeries.update({
          where: { id: seriesId },
          data: { skippedDates: { push: date }, conflictDates: series.conflictDates.filter((d) => d !== date) },
        });
        await this.cancelSessions(tx, seriesId, { date, tz, reason: 'series_skipped' });
      });
    }
    return this.toDto(seriesId);
  }

  /** Stop the series from this date on (the date itself is cancelled too). */
  async cancelFrom(user: AuthenticatedUser, seriesId: string, date: string) {
    const series = await this.loadWritable(user, seriesId);
    const tz = await this.venueTz(series.venueId!);
    this.assertOccurrence(series, date);
    this.assertNotPast(date, series.startTime, tz);
    await this.prisma.$transaction(async (tx) => {
      await this.cancelSessions(tx, seriesId, { fromDate: date, tz, reason: 'series_cancelled' });
      const lastKept = addDays(date, -7);
      const noneLeft = lastKept < series.startDate!;
      await tx.recurringBookingSeries.update({
        where: { id: seriesId },
        data: noneLeft ? { status: 'ended', until: null } : { until: lastKept },
      });
    });
    return this.toDto(seriesId);
  }

  /**
   * New time (and optionally court/length) from a date onward. The old series keeps its
   * past, a new series takes over — so history is never rewritten. `preview` only reports
   * which of the new dates would clash.
   */
  async reschedule(user: AuthenticatedUser, seriesId: string, dto: RescheduleSeriesDto) {
    const series = await this.loadWritable(user, seriesId);
    const venueId = series.venueId!;
    const tz = await this.venueTz(venueId);
    this.assertOccurrence(series, dto.fromDate);
    this.assertNotPast(dto.fromDate, dto.startTime, tz);
    const courtId = dto.courtId ?? series.courtId;
    const court = await this.loadCourt(courtId, venueId);
    const duration = dto.durationMinutes ?? series.durationMins;
    if (duration % 15 !== 0) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'INVALID_DURATION', 'Duration must be a multiple of 15 minutes');
    }

    const dates = seriesDates(dto.fromDate, { until: series.until }).filter((d) => !series.skippedDates.includes(d));
    const horizonEnd = addDays(zonedDate(new Date(), tz), FIXED_HORIZON_WEEKS * 7);
    const conflicts: string[] = [];
    for (const date of dates) {
      if (date > horizonEnd) break;
      const { start, end } = sessionWindow(date, dto.startTime, duration, tz);
      const clash = await this.ownerBookings.slotConflict(
        this.prisma, courtId, venueId, start, end, undefined,
      );
      // Its own not-yet-cancelled sessions free up the moment they move.
      if (clash && !(await this.isOwnSession(seriesId, courtId, start, end))) conflicts.push(date);
    }
    if (dto.preview) return { conflicts, dates };

    const created = await this.prisma.$transaction(async (tx) => {
      await this.cancelSessions(tx, seriesId, { fromDate: dto.fromDate, tz, reason: 'series_rescheduled' });
      const lastKept = addDays(dto.fromDate, -7);
      const noneLeft = lastKept < series.startDate!;
      await tx.recurringBookingSeries.update({
        where: { id: seriesId },
        data: noneLeft ? { status: 'ended', until: null } : { until: lastKept },
      });
      return tx.recurringBookingSeries.create({
        data: {
          courtId,
          venueId,
          kind: 'manual',
          dayOfWeek: series.dayOfWeek,
          startTime: dto.startTime,
          durationMins: duration,
          customerName: series.customerName,
          customerPhone: series.customerPhone,
          paymentPlan: series.paymentPlan === 'prepaid' ? 'per_session' : series.paymentPlan,
          priceAmount: series.priceAmount,
          startDate: dto.fromDate,
          until: series.until,
          skippedDates: series.skippedDates.filter((d) => d >= dto.fromDate),
          sourceKey: series.sourceKey,
          sourceLabel: series.sourceLabel,
          notes: series.notes,
          createdByUserId: series.createdByUserId,
        },
      });
    });
    const filled = await this.fillHorizon(created, { ...court, timeZone: tz }, { actorId: user.id });
    await this.recordConflicts(created.id, filled.conflicts);
    return { ...(await this.toDto(created.id)), created: filled.created, conflicts: filled.conflicts };
  }

  // ---- the daily job ------------------------------------------------------

  @Cron('30 3 * * *', { timeZone: 'Africa/Cairo' })
  async dailyExtend(): Promise<void> {
    try {
      await withJobLock(this.prisma, 'fixedBookings.extend', async () => {
        await this.extendAll();
      });
    } catch (err) {
      this.logger.error(`Fixed booking extension failed: ${String(err)}`);
    }
  }

  /** Keeps every active series booked {@link FIXED_HORIZON_WEEKS} weeks ahead; tells the owner once per new clash. */
  async extendAll(now: Date = new Date()): Promise<{ series: number; created: number; conflicts: number }> {
    const rows = await this.prisma.recurringBookingSeries.findMany({
      where: { kind: 'manual', status: 'active', venueId: { not: null } },
    });
    let created = 0;
    let conflicts = 0;
    for (const row of rows) {
      try {
        const court = await this.loadCourt(row.courtId, row.venueId!);
        const ctx: CourtCtx = { ...court, timeZone: await this.venueTz(row.venueId!) };
        const result = await this.fillHorizon(row, ctx, { actorId: row.createdByUserId ?? undefined, now });
        created += result.created;
        const fresh = result.conflicts.filter((d) => !row.conflictDates.includes(d));
        if (fresh.length) {
          conflicts += fresh.length;
          await this.recordConflicts(row.id, fresh);
          await this.notifyConflicts(row, ctx, fresh);
        }
      } catch (err) {
        this.logger.warn(`Series ${row.id} skipped: ${String(err)}`);
      }
    }
    return { series: rows.length, created, conflicts };
  }

  // ---- internals ----------------------------------------------------------

  /**
   * Books every date inside the horizon that has no booking yet. A date that already
   * has a booking row of ANY status was handled (an owner who cancelled one session by
   * hand does not get it back). Returns the dates that could not be booked.
   */
  private async fillHorizon(
    series: RecurringBookingSeries,
    court: CourtCtx,
    opts: { actorId?: string; now?: Date; prepaid?: { amount: number; method?: string } },
  ): Promise<{ created: number; conflicts: string[] }> {
    const now = opts.now ?? new Date();
    const actorId = opts.actorId ?? series.createdByUserId;
    if (!actorId) return { created: 0, conflicts: [] };
    const tz = court.timeZone;
    const horizonEnd = addDays(zonedDate(now, tz), FIXED_HORIZON_WEEKS * 7);
    const dates = seriesDates(series.startDate!, { until: series.until, toDate: horizonEnd }).filter(
      (d) => !series.skippedDates.includes(d),
    );
    let created = 0;
    let firstBooked = false;
    const conflicts: string[] = [];
    for (const date of dates) {
      const { start, end } = sessionWindow(date, series.startTime, series.durationMins, tz);
      if (isPastSlotStart(start, now.getTime())) continue;
      const exists = await this.prisma.booking.findFirst({
        where: { recurringSeriesId: series.id, slotStart: start },
        select: { id: true },
      });
      if (exists) continue;
      const price = series.priceAmount ?? this.quote(court, start, series.durationMins);
      if (price == null) {
        conflicts.push(date);
        continue;
      }
      const prepaid = opts.prepaid && !firstBooked ? opts.prepaid : undefined;
      try {
        await this.prisma.$transaction(
          (tx) =>
            this.ownerBookings.insertManualBooking(tx, {
              userId: actorId,
              venueId: series.venueId!,
              courtId: series.courtId,
              slotStart: start,
              slotEnd: end,
              priceAmount: price,
              paymentStatus: prepaid ? (prepaid.amount >= price ? 'paid' : 'partial') : 'unpaid',
              paidAmount: prepaid && prepaid.amount < price ? prepaid.amount : undefined,
              paymentMethod: prepaid?.method,
              customerName: series.customerName,
              customerPhone: series.customerPhone,
              sourceKey: series.sourceKey ?? undefined,
              sourceLabel: series.sourceLabel,
              notes: series.notes,
              recurringSeriesId: series.id,
            }),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        created += 1;
        firstBooked = true;
      } catch (error) {
        if (error instanceof ConflictException || isBookingSlotConflict(error)) {
          conflicts.push(date);
          continue;
        }
        throw error;
      }
    }
    return { created, conflicts };
  }

  private async buildSessions(shape: ResolvedShape, skipDates: string[]): Promise<PreviewSession[]> {
    const now = new Date();
    const horizonEnd = addDays(zonedDate(now, shape.court.timeZone), FIXED_HORIZON_WEEKS * 7);
    const dates = seriesDates(shape.startDate, { until: shape.until });
    const out: PreviewSession[] = [];
    for (const date of dates) {
      const { start, end } = sessionWindow(date, shape.startTime, shape.durationMins, shape.court.timeZone);
      const skipped = skipDates.includes(date);
      let conflict: PreviewSession['conflict'] = null;
      if (isPastSlotStart(start, now.getTime())) conflict = 'SLOT_IN_PAST';
      else if (date <= horizonEnd) {
        conflict = await this.ownerBookings.slotConflict(
          this.prisma, shape.court.id, shape.court.venueId, start, end,
        );
      }
      out.push({
        date,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        priceAmount: shape.priceAmount ?? this.quote(shape.court, start, shape.durationMins),
        conflict,
        bookedNow: date <= horizonEnd,
        skipped,
      });
    }
    return out;
  }

  private async resolveShape(dto: FixedSeriesShapeDto): Promise<ResolvedShape> {
    if (dto.durationMinutes % 15 !== 0) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'INVALID_DURATION', 'Duration must be a multiple of 15 minutes');
    }
    const court = await this.loadCourt(dto.courtId, dto.venueId);
    const tz = await this.venueTz(dto.venueId);
    const first = new Date(dto.startsAt);
    const startDate = zonedDate(first, tz);
    const startTime = zonedHhmm(first, tz);
    if (!dto.weeks && !dto.until) {
      throw new BadRequestException('Choose how long it repeats: weeks or until');
    }
    let until = dto.until ?? null;
    if (until) {
      if (!isLocalDate(until) || until < startDate) throw new BadRequestException('until must be on or after the first session');
    } else {
      until = addDays(startDate, (dto.weeks! - 1) * 7);
    }
    if (until > addDays(startDate, 52 * 7)) throw new BadRequestException('A fixed booking can run for one year at most');
    return {
      court: { ...court, timeZone: tz },
      weekday: weekdayOfLocalDate(startDate),
      startDate,
      startTime,
      until,
      durationMins: dto.durationMinutes,
      priceAmount: dto.priceAmount ?? null,
    };
  }

  private async loadCourt(courtId: string, venueId: string) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { pricingRules: true },
    });
    if (!court || court.venueId !== venueId) {
      throw new BadRequestException('Court does not belong to this venue');
    }
    return { id: court.id, venueId: court.venueId, pricingRules: court.pricingRules };
  }

  private quote(court: CourtCtx, start: Date, durationMins: number): number | null {
    return quoteDurationPrice(court.pricingRules, start, durationMins, court.timeZone).priceAmount;
  }

  private async loadWritable(user: AuthenticatedUser, seriesId: string) {
    const series = await this.prisma.recurringBookingSeries.findUnique({ where: { id: seriesId } });
    if (!series || series.kind !== 'manual' || !series.venueId) throw new NotFoundException('Fixed booking not found');
    await assertVenueAccess(this.prisma, user, series.venueId, { write: true });
    if (series.status !== 'active') throw new BadRequestException('This fixed booking has ended');
    return series;
  }

  private assertOccurrence(series: RecurringBookingSeries, date: string) {
    const ok =
      isLocalDate(date) &&
      date >= series.startDate! &&
      (!series.until || date <= series.until) &&
      weekdayOfLocalDate(date) === weekdayOfLocalDate(series.startDate!);
    if (!ok) throw new BadRequestException('That date is not one of this fixed booking\'s sessions');
  }

  private assertNotPast(date: string, hhmm: string, tz: string) {
    if (isPastSlotStart(sessionWindow(date, hhmm, 15, tz).start)) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'SLOT_IN_PAST', 'This time has already passed');
    }
  }

  /** Soft-cancels a series' upcoming sessions (one date, or from a date on). */
  private async cancelSessions(
    tx: Prisma.TransactionClient,
    seriesId: string,
    opts: { date?: string; fromDate?: string; tz: string; reason: string },
  ) {
    const where: Prisma.BookingWhereInput = {
      recurringSeriesId: seriesId,
      status: { in: ['held', 'confirmed'] },
    };
    if (opts.date) {
      where.slotStart = {
        gte: sessionWindow(opts.date, '00:00', 15, opts.tz).start,
        lt: sessionWindow(addDays(opts.date, 1), '00:00', 15, opts.tz).start,
      };
    } else if (opts.fromDate) {
      where.slotStart = { gte: sessionWindow(opts.fromDate, '00:00', 15, opts.tz).start };
    }
    const rows = await tx.booking.findMany({ where, select: { id: true } });
    for (const row of rows) {
      await tx.booking.update({
        where: { id: row.id },
        data: { status: 'cancelled', cancelledAt: new Date(), cancellationReason: opts.reason },
      });
      await this.ledger.syncBookingLedger(tx, row.id, 'cancelled');
    }
  }

  private async isOwnSession(seriesId: string, courtId: string, start: Date, end: Date) {
    const others = await this.prisma.booking.findFirst({
      where: {
        courtId,
        status: { in: ['held', 'confirmed'] },
        slotStart: { lt: end },
        slotEnd: { gt: start },
        OR: [{ recurringSeriesId: { not: seriesId } }, { recurringSeriesId: null }],
      },
      select: { id: true },
    });
    return !others;
  }

  private async recordConflicts(seriesId: string, dates: string[]) {
    const row = await this.prisma.recurringBookingSeries.findUnique({ where: { id: seriesId }, select: { conflictDates: true } });
    if (!row) return;
    const merged = Array.from(new Set([...row.conflictDates, ...dates])).sort();
    if (merged.length !== row.conflictDates.length) {
      await this.prisma.recurringBookingSeries.update({ where: { id: seriesId }, data: { conflictDates: merged } });
    }
  }

  private async notifyConflicts(series: RecurringBookingSeries, court: CourtCtx, dates: string[]) {
    const venue = await this.prisma.venue.findUnique({ where: { id: series.venueId! }, select: { ownerId: true } });
    if (!venue) return;
    const list = dates.join('، ');
    const who = series.customerName ?? '';
    await this.notifications
      .create({
        userId: venue.ownerId,
        category: 'system',
        titleAr: 'تعارض في حجز ثابت',
        titleEn: 'A fixed booking clashes',
        bodyAr: `حجز ${who} الثابت مش هيتحجز في: ${list}. راجعه من تاب الحجوزات.`,
        bodyEn: `${who}'s fixed booking could not be placed on: ${dates.join(', ')}. Review it in Bookings.`,
        deepLink: '/owner/bookings',
        payload: { kind: 'fixed_booking_conflict', seriesId: series.id, courtId: court.id, dates },
      })
      .catch((err) => this.logger.warn(`fixed conflict notice failed: ${String(err)}`));
  }

  private async venueTz(venueId: string): Promise<string> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { country: { select: { timezone: true } } },
    });
    return venue?.country?.timezone ?? 'Africa/Cairo';
  }

  private async toDto(seriesId: string) {
    const row = await this.prisma.recurringBookingSeries.findUniqueOrThrow({ where: { id: seriesId } });
    return this.mapSeries(row);
  }

  private mapSeries(row: RecurringBookingSeries) {
    return {
      id: row.id,
      venueId: row.venueId,
      courtId: row.courtId,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      weekday: row.dayOfWeek,
      startTime: row.startTime,
      durationMinutes: row.durationMins,
      priceAmount: row.priceAmount,
      paymentPlan: row.paymentPlan,
      startDate: row.startDate,
      until: row.until,
      status: row.status,
      skippedDates: row.skippedDates,
      conflictDates: row.conflictDates,
    };
  }
}

