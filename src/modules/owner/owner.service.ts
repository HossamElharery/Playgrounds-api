import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStaffInviteDto } from './dto/staff-invite.dto';
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

const MAX_FINANCE_RANGE_MS = 93 * 86_400_000;

@Injectable()
export class OwnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly nlu: GeminiNluService,
  ) {}

  private async venueTimeZone(venueId: string): Promise<string> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { country: { select: { timezone: true } } },
    });
    return venue?.country?.timezone ?? 'UTC';
  }

  private async assertVenueOwnership(venueId: string, ownerId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    if (venue.ownerId !== ownerId)
      throw new ForbiddenException('Not your venue');
    return venue;
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

  async calendar(ownerId: string, venueId: string, date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    await this.assertVenueOwnership(venueId, ownerId);
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
  async board(ownerId: string, venueId: string, date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    await this.assertVenueOwnership(venueId, ownerId);
    const courts = await this.prisma.court.findMany({
      where: { venueId },
      include: { pricingRules: true },
      orderBy: { name: 'asc' },
    });
    const rows = await Promise.all(
      courts.map(async (court) => ({
        court,
        slots: await this.bookings.getSlotGrid(court.id, date),
      })),
    );
    return { venueId, date, courts: rows };
  }

  /**
   * Turns a spoken/typed sentence into a structured schedule command. Gemini
   * only proposes — the frontend always shows a confirm-before-execute card,
   * and every field here is re-validated against this owner's real venue
   * before it can reach that card (see gemini-nlu.service.ts for the rest).
   */
  async interpretScheduleCommand(
    ownerId: string,
    venueId: string,
    text: string,
  ): Promise<NluResult & { available: boolean }> {
    await this.assertVenueOwnership(venueId, ownerId);
    if (!text || text.trim().length < 2 || text.length > 400) {
      throw new BadRequestException('text must be 2-400 characters');
    }
    if (!this.nlu.enabled) {
      return {
        intent: 'unknown', courtIds: [], allCourts: false, date: '',
        fromMins: null, toMins: null, reason: '', confidence: 0, available: false,
      };
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
      return {
        intent: 'unknown', courtIds: [], allCourts: false, date: today,
        fromMins: null, toMins: null, reason: '', confidence: 0, available: true,
      };
    }
    return { ...result, available: true };
  }

  /** Newest first; the caller derives the current undo token from items[0]. */
  async listAssistantMessages(
    ownerId: string,
    venueId: string,
    limit = 30,
    cursor?: string,
  ) {
    await this.assertVenueOwnership(venueId, ownerId);
    return paginateByCursor(
      (args) =>
        this.prisma.assistantMessage.findMany({
          where: { venueId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...args,
        }),
      limit,
      cursor,
    );
  }

  createAssistantMessage(ownerId: string, dto: CreateAssistantMessageDto) {
    return this.assertVenueOwnership(dto.venueId, ownerId).then((venue) =>
      this.prisma.assistantMessage.create({
        data: {
          venueId: venue.id,
          ownerId,
          sender: dto.sender,
          text: dto.text,
          appliedChange: dto.appliedChange as Prisma.InputJsonValue | undefined,
          inverseChange: dto.inverseChange as Prisma.InputJsonValue | undefined,
        },
      }),
    );
  }

  /**
   * Marks the stored inverse as consumed and hands it back so the frontend can
   * apply it through the same /owner/calendar/blocks flow it already uses for
   * every other change — this endpoint only guards against double-undo.
   */
  async undoAssistantMessage(ownerId: string, venueId: string, messageId: string) {
    await this.assertVenueOwnership(venueId, ownerId);
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

  async createWalkInBooking(ownerId: string, dto: CreateWalkInDto) {
    await this.assertVenueOwnership(dto.venueId, ownerId);
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
              userId: ownerId,
              slotStart,
              slotEnd,
              baseAmount: amount,
              totalAmount: amount,
              status: 'confirmed',
              paymentStatus: 'paid',
              paymentMethod: 'cash',
              guestName: dto.customerName,
              guestPhone: dto.customerPhone,
              cancellationReason: `walk-in: ${dto.customerName}`,
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

  async finance(ownerId: string, venueId: string, from: string, to: string) {
    const venue = await this.assertVenueOwnership(venueId, ownerId);
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
      currency: bookings[0]?.currency ?? venue.priceFromCurrency,
      paidBookings: bookings.length,
      revenueByDay: byDay,
      revenueByCourt: byCourt,
      totalRevenue,
      commissionAmount: Math.round((totalRevenue * commissionBps) / 10_000),
      netPayout:
        totalRevenue - Math.round((totalRevenue * commissionBps) / 10_000),
    };
  }

  async customers(ownerId: string, venueId: string) {
    await this.assertVenueOwnership(venueId, ownerId);
    const bookings = await this.prisma.booking.groupBy({
      by: ['userId'],
      where: { venueId, status: { in: ['completed', 'no_show'] } },
      _count: { _all: true },
    });
    const noShows = await this.prisma.booking.groupBy({
      by: ['userId'],
      where: { venueId, status: 'no_show' },
      _count: { _all: true },
    });
    const noShowMap = new Map(noShows.map((n) => [n.userId, n._count._all]));

    const users = await this.prisma.user.findMany({
      where: { id: { in: bookings.map((b) => b.userId) } },
      select: { id: true, name: true, phone: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return bookings
      .map((b) => ({
        user: userMap.get(b.userId),
        totalBookings: b._count._all,
        noShows: noShowMap.get(b.userId) ?? 0,
      }))
      .sort((a, b) => b.totalBookings - a.totalBookings);
  }

  // ---- Staff invites ----
  async inviteStaff(ownerId: string, dto: CreateStaffInviteDto) {
    if (!dto.inviteeEmail && !dto.inviteePhone) {
      throw new BadRequestException('inviteeEmail or inviteePhone is required');
    }
    await this.assertVenueOwnership(dto.venueId, ownerId);
    const duplicate = await this.prisma.staffInvite.findFirst({
      where: {
        venueId: dto.venueId,
        status: { in: ['pending', 'accepted'] },
        OR: [
          dto.inviteeEmail ? { inviteeEmail: dto.inviteeEmail } : undefined,
          dto.inviteePhone ? { inviteePhone: dto.inviteePhone } : undefined,
        ].filter(Boolean) as object[],
      },
    });
    if (duplicate) {
      throw new ConflictException('STAFF_ALREADY_INVITED');
    }
    const inviteeUser = dto.inviteePhone
      ? await this.prisma.user.findUnique({ where: { phone: dto.inviteePhone } })
      : dto.inviteeEmail
        ? await this.prisma.user.findUnique({ where: { email: dto.inviteeEmail } })
        : null;
    return this.prisma.staffInvite.create({
      data: {
        venueId: dto.venueId,
        invitedById: ownerId,
        inviteePhone: dto.inviteePhone,
        inviteeEmail: dto.inviteeEmail,
        inviteeUserId: inviteeUser?.id,
        roleId: dto.roleId,
        operationalRole: dto.operationalRole,
      },
    });
  }

  async listStaffInvites(ownerId: string, venueId: string) {
    await this.assertVenueOwnership(venueId, ownerId);
    return this.prisma.staffInvite.findMany({ where: { venueId } });
  }

  async acceptStaffInvite(userId: string, inviteId: string) {
    const invite = await this.prisma.staffInvite.findUnique({
      where: { id: inviteId },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (invite.status !== 'pending') throw new BadRequestException('Only pending invitations can be accepted');
    if (!((invite.inviteePhone && invite.inviteePhone === user.phone) ||
      (invite.inviteeEmail && user.email && invite.inviteeEmail.toLowerCase() === user.email.toLowerCase())))
      throw new ForbiddenException('This invite is not for you');

    await this.prisma.$transaction([
      this.prisma.staffInvite.update({
        where: { id: inviteId },
        data: { status: 'accepted', inviteeUserId: userId },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { roles: { set: Array.from(new Set([...user.roles, 'staff'])) } },
      }),
      ...(invite.roleId
        ? [
            this.prisma.userRoleAssignment.create({
              data: { userId, roleId: invite.roleId, venueId: invite.venueId },
            }),
          ]
        : []),
    ]);
  }

  async revokeStaffInvite(ownerId: string, inviteId: string) {
    return this.setStaffStatus(ownerId, inviteId, 'revoked');
  }

  async setStaffStatus(
    ownerId: string,
    inviteId: string,
    status: 'accepted' | 'suspended' | 'revoked',
  ) {
    const invite = await this.prisma.staffInvite.findUnique({
      where: { id: inviteId },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    await this.assertVenueOwnership(invite.venueId, ownerId);
    if (status === 'accepted' && (invite.status !== 'suspended' || !invite.inviteeUserId)) throw new BadRequestException('The invited user must accept their invitation first');
    return this.prisma.$transaction(async tx => {
    if (status !== 'accepted' && invite.inviteeUserId) {
      await tx.userRoleAssignment.deleteMany({
        where: { userId: invite.inviteeUserId, venueId: invite.venueId },
      });
    }
    if (status === 'accepted' && invite.inviteeUserId && invite.roleId) {
      const existing = await tx.userRoleAssignment.findFirst({ where: { userId: invite.inviteeUserId, venueId: invite.venueId, roleId: invite.roleId } });
      if (!existing) await tx.userRoleAssignment.create({ data: { userId: invite.inviteeUserId, venueId: invite.venueId, roleId: invite.roleId } });
    }
    return tx.staffInvite.update({
      where: { id: inviteId },
      data: { status },
    });
    });
  }

  async createCalendarBlock(ownerId: string, dto: CreateCalendarBlockDto) {
    await this.assertVenueOwnership(dto.venueId, ownerId);
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
        createdById: ownerId,
      },
    });
  }

  async deleteCalendarBlock(ownerId: string, blockId: string) {
    const block = await this.prisma.calendarBlock.findUnique({
      where: { id: blockId },
    });
    if (!block) throw new NotFoundException('Block not found');
    await this.assertVenueOwnership(block.venueId, ownerId);
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

  async financeCsv(ownerId: string, venueId: string, from: string, to: string) {
    const summary = await this.finance(ownerId, venueId, from, to);
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
