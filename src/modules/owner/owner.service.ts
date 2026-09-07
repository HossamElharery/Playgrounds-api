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
  CreateCalendarBlockDto,
  CreatePayoutMethodDto,
  CreateWalkInDto,
} from './dto/owner-operations.dto';
import { isBookingSlotConflict } from '../../common/utils/booking-slot-conflict.util';

const MAX_FINANCE_RANGE_MS = 93 * 86_400_000;

@Injectable()
export class OwnerService {
  constructor(private readonly prisma: PrismaService) {}

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
    weekStart.setDate(weekStart.getDate() - 7);

    const [
      todaySchedule,
      todayRevenueAgg,
      pendingCount,
      weekBookings,
      totalCourts,
      latestApplication,
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
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

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
    await this.assertVenueOwnership(venueId, ownerId);
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
        slotStart: true,
        court: { select: { name: true } },
      },
    });

    const byDay: Record<string, number> = {};
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
    if (
      invite.inviteePhone !== user.phone &&
      invite.inviteeEmail !== user.email
    )
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
    const invite = await this.prisma.staffInvite.findUnique({
      where: { id: inviteId },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    await this.assertVenueOwnership(invite.venueId, ownerId);
    return this.prisma.staffInvite.update({
      where: { id: inviteId },
      data: { status: 'revoked' },
    });
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
    if (status === 'revoked' && invite.inviteeUserId) {
      await this.prisma.userRoleAssignment.deleteMany({
        where: { userId: invite.inviteeUserId, venueId: invite.venueId },
      });
    }
    return this.prisma.staffInvite.update({
      where: { id: inviteId },
      data: { status },
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
      ].join(',');
    });
    const csv = `\uFEFF${header.join(',')}\n${rows.join('\n')}\n# totalRevenue,${summary.totalRevenue}\n# commissionAmount,${summary.commissionAmount}\n# netPayout,${summary.netPayout}\n`;
    return csv;
  }
}
