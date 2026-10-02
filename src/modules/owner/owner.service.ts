import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { loadStaffScope } from '../../common/access/staff-scope';
import { PERMISSION_KEYS } from '../../common/access/permissions';
import { assertSlotNotInPast } from '../../common/utils/past-slot.util';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { queryCustomers, queryUnlinkedBookings } from './customers/customers.query';
import {
  CreateAssistantMessageDto,
  CreateCalendarBlockDto,
  CreatePayoutMethodDto,
  CreateWalkInDto,
} from './dto/owner-operations.dto';
import { isBookingSlotConflict } from '../../common/utils/booking-slot-conflict.util';
import { zonedDayBounds } from '../../common/utils/timezone.util';
import { paginateByCursor } from '../../common/pagination/cursor-pagination.dto';
import { BookingsService } from '../bookings/bookings.service';
import { GeminiNluService, NluResult } from './gemini-nlu.service';
import { AssistantTranscriptService } from '../ai/transcript/assistant-transcript.service';
import { UNDO_ANCHOR_TEXT } from './assistant/assistant-undo';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { assertVenueAccess } from '../../common/access/owner-access';
import { sourceDisplay } from '../../common/utils/source-label.util';
import { maskPlayerPhone } from '../../common/utils/phone.util';

function unknownNlu(date: string, available: boolean): NluResult & { available: boolean } {
  return {
    intent: 'unknown',
    courtIds: [],
    allCourts: false,
    date,
    fromMins: null,
    toMins: null,
    durationMinutes: null,
    priceAmount: null,
    sourceKey: null,
    paid: null,
    customerName: '',
    reason: '',
    confidence: 0,
    available,
  };
}

function unitNoun(activityKind: string | null | undefined): 'court' | 'station' | 'table' {
  if (activityKind === 'gaming-station') return 'station';
  if (activityKind === 'table-game') return 'table';
  return 'court';
}

const MAX_FINANCE_RANGE_MS = 93 * 86_400_000;

@Injectable()
export class OwnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly nlu: GeminiNluService,
    @Optional() private readonly transcript?: AssistantTranscriptService,
  ) {}

  private async venueTimeZone(venueId: string): Promise<string> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { country: { select: { timezone: true } } },
    });
    return venue?.country?.timezone ?? 'UTC';
  }

  private async requireVenue(
    user: AuthenticatedUser,
    venueId: string,
    write: boolean,
  ) {
    return assertVenueAccess(this.prisma, user, venueId, { write });
  }

  /** @deprecated use requireVenue with the authenticated user */
  private async assertVenueOwnership(venueId: string, ownerId: string) {
    const user = {
      id: ownerId,
      phone: '',
      name: '',
      roles: ['owner' as const],
    };
    return this.requireVenue(user, venueId, true);
  }

  private parseFinanceRange(from: string, to: string): { start: Date; end: Date } {
    const start = new Date(from);
    const end = new Date(to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) end.setUTCHours(23, 59, 59, 999);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid from/to date');
    }
    if (end < start) {
      throw new BadRequestException('to must be on or after from');
    }
    if (end.getTime() - start.getTime() > MAX_FINANCE_RANGE_MS) {
      throw new BadRequestException('Date range cannot exceed 93 days');
    }
    return { start, end };
  }

  /**
   * What the signed-in person may do in the owner dashboard. The frontend uses it to
   * build the menu and hide actions; the API enforces the same keys on every route.
   */
  async access(user: AuthenticatedUser) {
    if (user.roles.includes('admin') || user.roles.includes('owner')) {
      return {
        role: user.roles.includes('admin') ? ('admin' as const) : ('owner' as const),
        permissions: [...PERMISSION_KEYS],
        venueIds: null as string[] | null,
        ownerId: user.id,
        title: null as string | null,
        canManageTeam: true,
      };
    }
    const scope = await loadStaffScope(this.prisma, user.id);
    return {
      role: 'staff' as const,
      permissions: scope?.permissions ?? [],
      venueIds: scope?.venueIds ?? [],
      ownerId: scope?.ownerId ?? null,
      title: scope?.title ?? null,
      canManageTeam: !!scope?.permissions.includes('team.manage'),
    };
  }

  async overview(ownerId: string) {
    const venues = await this.prisma.venue.findMany({
      where: { ownerId },
      select: { id: true },
    });
    const venueIds = venues.map((v) => v.id);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 6);

    const [
      todaySchedule,
      todayRevenueAgg,
      pendingCount,
      weekBookings,
      totalCourts,
      latestApplication,
      revenueByCurrency,
    ] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          venueId: { in: venueIds },
          slotStart: { gte: todayStart, lt: todayEnd },
          status: { in: ['confirmed', 'completed'] },
        },
        include: { court: true, user: { select: { name: true } } },
        orderBy: { slotStart: 'asc' },
      }),
      this.prisma.booking.aggregate({
        where: {
          venueId: { in: venueIds },
          slotStart: { gte: todayStart, lt: todayEnd },
          status: { in: ['confirmed', 'completed'] },
        },
        _sum: { totalAmount: true },
      }),
      this.prisma.booking.count({
        where: { venueId: { in: venueIds }, status: 'held' },
      }),
      this.prisma.booking.count({
        where: {
          venueId: { in: venueIds },
          slotStart: { gte: weekStart, lt: todayEnd },
          status: { in: ['confirmed', 'completed'] },
        },
      }),
      this.prisma.court.count({ where: { venueId: { in: venueIds } } }),
      this.prisma.partnerApplication.findFirst({
        where: { ownerId },
        orderBy: { updatedAt: 'desc' },
        include: { events: { orderBy: { createdAt: 'desc' }, take: 8 } },
      }),
      this.prisma.booking.groupBy({ by: ['currency'], where: { venueId: { in: venueIds }, status: { in: ['confirmed','completed'] }, paymentStatus: 'paid' }, _sum: { totalAmount: true } }),
    ]);

    const possibleSlotsPerWeek = totalCourts * 14; // rough: 14 slots/day capacity heuristic
    const weeklyOccupancyPct = possibleSlotsPerWeek
      ? Math.min(100, Math.round((weekBookings / possibleSlotsPerWeek) * 100))
      : 0;

    return {
      application: latestApplication
        ? {
            id: latestApplication.id,
            status: latestApplication.status,
            version: latestApplication.version,
            publicNameEn: latestApplication.publicNameEn,
            publicNameAr: latestApplication.publicNameAr,
            nextAction: this.applicationNextAction(latestApplication.status),
            history: latestApplication.events,
          }
        : null,
      todaySchedule,
      weeklyBookingsCount: weekBookings,
      revenueByCurrency: revenueByCurrency.map(row => ({ currency: row.currency, amount: row._sum.totalAmount ?? 0 })),
      todayRevenueAmount: todayRevenueAgg._sum.totalAmount ?? 0,
      pendingRequests: pendingCount,
      weeklyOccupancyPct,
      analyticsLocked: latestApplication
        ? latestApplication.status !== 'approved'
        : venueIds.length === 0,
    };
  }

  private applicationNextAction(status: string) {
    switch (status) {
      case 'draft':
        return 'continue_application';
      case 'changes_requested':
        return 'address_feedback';
      case 'pending':
        return 'wait_for_review';
      case 'approved':
        return 'open_operations';
      case 'rejected':
        return 'contact_support';
      case 'suspended':
        return 'wait_for_review';
      default:
        return 'continue_application';
    }
  }

  async calendar(user: AuthenticatedUser, venueId: string, date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    await this.requireVenue(user, venueId, false);
    // Must match the slot grid's window, or a late-evening block shows up in one
    // view and not the other whenever the server clock is not the venue's.
    const { start: dayStart, end: dayEnd } = zonedDayBounds(
      date,
      await this.venueTimeZone(venueId),
    );

    const [bookings, blocks] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          venueId,
          slotStart: { gte: dayStart, lt: dayEnd },
          status: { in: ['held', 'confirmed', 'completed'] },
        },
        include: {
          court: true,
          user: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { slotStart: 'asc' },
      }),
      this.prisma.calendarBlock.findMany({
        where: {
          venueId,
          startsAt: { lt: dayEnd },
          endsAt: { gt: dayStart },
        },
        include: { court: { select: { id: true, name: true } } },
        orderBy: { startsAt: 'asc' },
      }),
    ]);

    return { date, bookings, blocks };
  }

  /**
   * Every court of a venue with its slot grid for one day, in a single call.
   * The dashboard used to fetch one grid per court and trip the rate limiter.
   */
  async board(user: AuthenticatedUser, venueId: string, date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    await this.requireVenue(user, venueId, false);
    const timeZone = await this.venueTimeZone(venueId);
    const { start: dayStart, end: dayEnd } = zonedDayBounds(date, timeZone);
    const courts = await this.prisma.court.findMany({
      where: { venueId },
      include: {
        pricingRules: true,
        sport: { select: { activityKind: true } },
      },
      orderBy: { name: 'asc' },
    });
    const dayBookings = await this.prisma.booking.findMany({
      where: {
        venueId,
        slotStart: { lt: dayEnd },
        slotEnd: { gt: dayStart },
        status: { in: ['held', 'confirmed', 'completed'] },
      },
      include: {
        user: { select: { name: true } },
        payments: { where: { status: 'paid' }, select: { amount: true } },
      },
    });
    // `BookingsService.getSlotGrid` already knows a cell is 'blocked' but only
    // as a boolean — it feeds the public availability screen too, so it isn't
    // the place to widen the contract. The owner board is the one screen that
    // needs to act on a block (reopen it), so it re-fetches the same rows
    // here and attaches the id the same way it already attaches `bookingId`.
    const dayBlocks = await this.prisma.calendarBlock.findMany({
      where: {
        venueId,
        startsAt: { lt: dayEnd },
        endsAt: { gt: dayStart },
      },
    });
    const now = new Date();
    const attentionFrom = new Date(now.getTime() - 24 * 3_600_000);
    const rows = await Promise.all(
      courts.map(async (court) => {
        const slots = await this.bookings.getSlotGrid(court.id, date);
        const kind = court.sport?.activityKind ?? null;
        // The first grid cell a booking touches is its head; the rest are
        // continuation cells (spanSlots 0) that the client folds away. Matching
        // on an exact start time used to lose any booking that did not begin on
        // a slot boundary — e.g. a walk-in entered at 15:53.
        const headSlotFor = new Map<string, number>();
        slots.forEach((slot, index) => {
          const start = new Date(slot.start);
          const end = new Date(slot.end);
          for (const b of dayBookings) {
            if (b.courtId !== court.id) continue;
            if (b.slotStart >= end || b.slotEnd <= start) continue;
            if (!headSlotFor.has(b.id)) headSlotFor.set(b.id, index);
          }
        });
        const enriched = slots.map((slot, index) => {
          const start = new Date(slot.start);
          const end = new Date(slot.end);
          const booking = dayBookings.find(
            (b) => b.courtId === court.id && b.slotStart < end && b.slotEnd > start,
          );
          const spanSlots = booking
            ? Math.max(
                1,
                Math.ceil(
                  (booking.slotEnd.getTime() - booking.slotStart.getTime()) /
                    (court.slotDurationMins * 60_000),
                ),
              )
            : 1;
          const isSpanHead = !!booking && headSlotFor.get(booking.id) === index;
          let state: 'free' | 'booked_platform' | 'booked_manual' | 'blocked' | 'past' =
            slot.state === 'blocked' ? 'blocked' : slot.state === 'past' ? 'past' : 'free';
          if (booking?.source === 'platform') state = 'booked_platform';
          else if (booking?.source === 'manual') state = 'booked_manual';
          // A venue-wide block (courtId null) and a per-court block can both
          // cover the same cell; either is fine to report back — reopening
          // either one is the same "free this slot up" action to the owner.
          const block =
            state === 'blocked'
              ? dayBlocks.find(
                  (b) =>
                    (!b.courtId || b.courtId === court.id) &&
                    b.startsAt < end &&
                    b.endsAt > start,
                )
              : undefined;
          const needsAttention = !!(
            booking &&
            booking.source === 'platform' &&
            booking.status === 'confirmed' &&
            !booking.checkedInAt &&
            booking.slotEnd <= now &&
            booking.slotEnd >= attentionFrom
          );
          return {
            ...slot,
            state,
            bookingId: booking?.id,
            blockId: block?.id,
            blockReason: block?.note,
            customerName:
              booking?.source === 'manual' ? booking.guestName : booking?.user?.name,
            sourceLabel: booking
              ? sourceDisplay(booking.source, booking.sourceKey, booking.sourceLabel).label
              : undefined,
            price: booking?.totalAmount,
            paymentStatus: booking?.paymentStatus,
            paidAmount: booking ? booking.payments.reduce((sum, p) => sum + p.amount, 0) : undefined,
            needsAttention,
            startsAt: booking?.slotStart.toISOString(),
            endsAt: booking?.slotEnd.toISOString(),
            spanSlots: isSpanHead ? spanSlots : booking ? 0 : 1,
          };
        });
        return {
          court,
          unitKind: kind,
          unitNoun: unitNoun(kind),
          slotDurationMins: court.slotDurationMins,
          slots: enriched,
        };
      }),
    );
    // The client formats every time in venue-local time, never the device tz.
    return { venueId, date, timezone: timeZone, courts: rows };
  }

  /**
   * Turns a spoken/typed sentence into a structured schedule command. Gemini
   * only proposes — the frontend always shows a confirm-before-execute card,
   * and every field here is re-validated against this owner's real venue
   * before it can reach that card (see gemini-nlu.service.ts for the rest).
   */
  async interpretScheduleCommand(
    user: AuthenticatedUser,
    venueId: string,
    text: string,
  ): Promise<NluResult & { available: boolean }> {
    await this.requireVenue(user, venueId, false);
    if (!text || text.trim().length < 2 || text.length > 400) {
      throw new BadRequestException('text must be 2-400 characters');
    }
    if (!this.nlu.enabled) {
      return unknownNlu('', false);
    }
    const timeZone = await this.venueTimeZone(venueId);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    const courts = await this.prisma.court.findMany({
      where: { venueId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const result = await this.nlu.interpret(text, courts, today);
    if (!result) {
      return unknownNlu(today, true);
    }
    return { ...result, available: true };
  }

  /** Newest first; the caller derives the current undo token from items[0]. */
  async listAssistantMessages(
    user: AuthenticatedUser,
    venueId: string,
    limit = 30,
    cursor?: string,
  ) {
    await this.requireVenue(user, venueId, false);
    return paginateByCursor(
      (args) =>
        this.prisma.assistantMessage.findMany({
          // The hidden undo-point rows are bookkeeping, not chat: they would eat the page.
          where: { venueId, NOT: { text: UNDO_ANCHOR_TEXT } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...args,
        }),
      limit,
      cursor,
    );
  }

  createAssistantMessage(user: AuthenticatedUser, dto: CreateAssistantMessageDto) {
    return this.requireVenue(user, dto.venueId, true).then(async (venue) => {
      const row = await this.prisma.assistantMessage.create({
        data: {
          venueId: venue.id,
          ownerId: user.id,
          sender: dto.sender,
          text: dto.text,
          appliedChange: dto.appliedChange as Prisma.InputJsonValue | undefined,
          inverseChange: dto.inverseChange as Prisma.InputJsonValue | undefined,
        },
      });
      // The admin's permanent copy: the server's own record of the line if it has one, else this one.
      void this.transcript?.mirrorClientLine({
        ownerId: user.id,
        ownerName: user.name,
        venueId: venue.id,
        sender: dto.sender,
        text: dto.text,
        scheduleChange: !!dto.inverseChange || !!dto.appliedChange,
      });
      return row;
    });
  }

  /**
   * Marks the stored inverse as consumed and hands it back so the frontend can
   * apply it through the same /owner/calendar/blocks flow it already uses for
   * every other change — this endpoint only guards against double-undo.
   */
  async undoAssistantMessage(user: AuthenticatedUser, venueId: string, messageId: string) {
    await this.requireVenue(user, venueId, true);
    const message = await this.prisma.assistantMessage.findUnique({ where: { id: messageId } });
    if (!message || message.venueId !== venueId) throw new NotFoundException('Message not found');
    if (!message.inverseChange) throw new BadRequestException('Nothing to undo');
    if (message.consumedAt) throw new ConflictException('Already undone');
    await this.prisma.assistantMessage.update({
      where: { id: messageId },
      data: { consumedAt: new Date() },
    });
    return message.inverseChange;
  }

  async createWalkInBooking(user: AuthenticatedUser, dto: CreateWalkInDto) {
    await this.requireVenue(user, dto.venueId, true);
    const court = await this.prisma.court.findUnique({
      where: { id: dto.courtId },
    });
    if (!court || court.venueId !== dto.venueId) {
      throw new BadRequestException('Court does not belong to this venue');
    }
    const slotStart = new Date(dto.slotStart);
    const slotEnd = new Date(dto.slotEnd);
    if (!(slotEnd > slotStart)) {
      throw new BadRequestException('slotEnd must be after slotStart');
    }
    assertSlotNotInPast(slotStart);

    const amount = dto.priceAmount ?? 0;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const overlap = await tx.booking.findFirst({
            where: {
              courtId: dto.courtId,
              status: { in: ['held', 'confirmed'] },
              slotStart: { lt: slotEnd },
              slotEnd: { gt: slotStart },
            },
          });
          if (overlap) throw new ConflictException('SLOT_ALREADY_HELD');

          const blocked = await tx.calendarBlock.findFirst({
            where: {
              venueId: dto.venueId,
              OR: [{ courtId: dto.courtId }, { courtId: null }],
              startsAt: { lt: slotEnd },
              endsAt: { gt: slotStart },
            },
          });
          if (blocked) throw new ConflictException('SLOT_BLOCKED');

          return tx.booking.create({
            data: {
              code: `WALKIN-${Date.now()}`,
              courtId: dto.courtId,
              venueId: dto.venueId,
              userId: user.id,
              slotStart,
              slotEnd,
              baseAmount: amount,
              totalAmount: amount,
              status: 'confirmed',
              paymentStatus: 'paid',
              paymentMethod: 'cash',
              guestName: dto.customerName,
              guestPhone: dto.customerPhone,
              source: 'manual',
              sourceKey: 'walk_in',
              notes: dto.customerName ? `walk-in: ${dto.customerName}` : null,
              createdByUserId: user.id,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (isBookingSlotConflict(error)) {
        throw new ConflictException('SLOT_ALREADY_HELD');
      }
      throw error;
    }
  }

  async finance(user: AuthenticatedUser, venueId: string, from: string, to: string) {
    const venue = await this.requireVenue(user, venueId, false);
    const { start, end } = this.parseFinanceRange(from, to);
    const bookings = await this.prisma.booking.findMany({
      where: {
        venueId,
        slotStart: { gte: start, lte: end },
        status: { in: ['confirmed', 'completed'] },
        paymentStatus: 'paid',
      },
      select: {
        totalAmount: true,
        currency: true,
        slotStart: true,
        court: { select: { name: true } },
      },
    });

    const byDay: Record<string, number> = {};
    const currencies = new Set(bookings.map(b => b.currency));
    if (currencies.size > 1) throw new BadRequestException('This period contains multiple currencies; a single-currency summary is unavailable');
    const byCourt: Record<string, number> = {};
    for (const b of bookings) {
      const day = b.slotStart.toISOString().slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + b.totalAmount;
      byCourt[b.court.name] = (byCourt[b.court.name] ?? 0) + b.totalAmount;
    }

    const commission = await this.prisma.commissionSetting.findUnique({
      where: { venueId },
    });
    const totalRevenue = bookings.reduce((s, b) => s + b.totalAmount, 0);
    const commissionBps = commission?.percentageBps ?? 500;

    return {
      currency: bookings[0]?.currency ?? venue.currency,
      paidBookings: bookings.length,
      revenueByDay: byDay,
      revenueByCourt: byCourt,
      totalRevenue,
      commissionAmount: Math.round((totalRevenue * commissionBps) / 10_000),
      netPayout:
        totalRevenue - Math.round((totalRevenue * commissionBps) / 10_000),
    };
  }

  async customers(user: AuthenticatedUser, venueId: string) {
    const venue = await this.requireVenue(user, venueId, false);
    const [items, unlinked] = await Promise.all([
      queryCustomers(this.prisma, venueId, venue.ownerId),
      queryUnlinkedBookings(this.prisma, venueId),
    ]);
    return { items, total: items.length, owedTotal: items.reduce((s, c) => s + c.owed, 0), unlinked };
  }

  /** A note on one customer ("always late", "VIP"): the venue's own memory, kept next to the bookings. */
  async setCustomerNote(user: AuthenticatedUser, venueId: string, key: string, note: string | null) {
    await this.requireVenue(user, venueId, true);
    if (!/^(p|m|n):.{1,80}$/.test(key)) throw new BadRequestException('Invalid customer key');
    const clean = note?.trim() ? note.trim().slice(0, 500) : null;
    if (!clean) {
      await this.prisma.venueCustomer.updateMany({ where: { venueId, key }, data: { note: null, updatedById: user.id } });
      return { key, note: null };
    }
    await this.prisma.venueCustomer.upsert({
      where: { venueId_key: { venueId, key } },
      create: { venueId, key, note: clean, updatedById: user.id },
      update: { note: clean, updatedById: user.id },
    });
    return { key, note: clean };
  }

  async createCalendarBlock(user: AuthenticatedUser, dto: CreateCalendarBlockDto) {
    await this.requireVenue(user, dto.venueId, true);
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (!(endsAt > startsAt)) {
      throw new BadRequestException('endsAt must be after startsAt');
    }
    if (dto.courtId) {
      const court = await this.prisma.court.findUnique({
        where: { id: dto.courtId },
      });
      if (!court || court.venueId !== dto.venueId) {
        throw new BadRequestException('Court does not belong to this venue');
      }
    }
    const overlap = await this.prisma.booking.findFirst({
      where: {
        venueId: dto.venueId,
        ...(dto.courtId ? { courtId: dto.courtId } : {}),
        status: { in: ['held', 'confirmed'] },
        slotStart: { lt: endsAt },
        slotEnd: { gt: startsAt },
      },
    });
    if (overlap) throw new ConflictException('BLOCK_OVERLAPS_BOOKING');
    return this.prisma.calendarBlock.create({
      data: {
        venueId: dto.venueId,
        courtId: dto.courtId,
        kind: dto.kind,
        startsAt,
        endsAt,
        note: dto.note,
        createdById: user.id,
      },
    });
  }

  async deleteCalendarBlock(user: AuthenticatedUser, blockId: string) {
    const block = await this.prisma.calendarBlock.findUnique({
      where: { id: blockId },
    });
    if (!block) throw new NotFoundException('Block not found');
    await this.requireVenue(user, block.venueId, true);
    await this.prisma.calendarBlock.delete({ where: { id: blockId } });
  }

  listPayoutMethods(ownerId: string) {
    return this.prisma.payoutMethod.findMany({
      where: { ownerId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        kind: true,
        accountHolder: true,
        identifierMasked: true,
        bankName: true,
        isDefault: true,
        createdAt: true,
      },
    });
  }

  async createPayoutMethod(ownerId: string, dto: CreatePayoutMethodDto) {
    const last4 = dto.identifier.replace(/\s+/g, '').slice(-4);
    const identifierMasked = `${'*'.repeat(Math.max(0, dto.identifier.length - 4))}${last4}`;
    if (dto.isDefault) {
      await this.prisma.payoutMethod.updateMany({
        where: { ownerId },
        data: { isDefault: false },
      });
    }
    const created = await this.prisma.payoutMethod.create({
      data: {
        ownerId,
        kind: dto.kind,
        accountHolder: dto.accountHolder,
        identifierMasked,
        bankName: dto.bankName,
        isDefault: dto.isDefault ?? false,
        details: { last4, kind: dto.kind },
      },
      select: {
        id: true,
        kind: true,
        accountHolder: true,
        identifierMasked: true,
        bankName: true,
        isDefault: true,
        createdAt: true,
      },
    });
    return created;
  }

  async deletePayoutMethod(ownerId: string, id: string) {
    const method = await this.prisma.payoutMethod.findUnique({ where: { id } });
    if (!method || method.ownerId !== ownerId) {
      throw new NotFoundException('Payout method not found');
    }
    await this.prisma.payoutMethod.delete({ where: { id } });
  }

  async financeCsv(user: AuthenticatedUser, venueId: string, from: string, to: string) {
    const summary = await this.finance(user, venueId, from, to);
    const { start, end } = this.parseFinanceRange(from, to);
    const bookings = await this.prisma.booking.findMany({
      where: {
        venueId,
        slotStart: { gte: start, lte: end },
        status: { in: ['confirmed', 'completed'] },
        paymentStatus: 'paid',
      },
      include: { court: true, user: { select: { name: true, phone: true } } },
      orderBy: { slotStart: 'asc' },
    });
    const commissionBps =
      (
        await this.prisma.commissionSetting.findUnique({
          where: { venueId },
        })
      )?.percentageBps ?? 500;
    const header = [
      'bookingId',
      'code',
      'slotStart',
      'court',
      'customer',
      'gross',
      'commission',
      'net',
      'currency',
      'status',
    ];
    const rows = bookings.map((b) => {
      const commission = Math.round((b.totalAmount * commissionBps) / 10_000);
      return [
        b.id,
        b.code,
        b.slotStart.toISOString(),
        b.court.name,
        b.guestName ?? b.user.name,
        b.totalAmount,
        commission,
        b.totalAmount - commission,
        b.currency,
        b.status,
      ].map(value => {
        const text = String(value ?? '');
        const safe = /^[=+@\-\t\r]/.test(text) ? "'" + text : text;
        return '"' + safe.replace(/"/g, '""') + '"';
      }).join(',');
    });
    const csv = `\uFEFF${header.join(',')}\n${rows.join('\n')}\n# totalRevenue,${summary.totalRevenue}\n# commissionAmount,${summary.commissionAmount}\n# netPayout,${summary.netPayout}\n`;
    return csv;
  }
}
