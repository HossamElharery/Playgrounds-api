import { isSafeReceiptUrl } from '../../common/utils/receipt-url.util';
import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Booking, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../finance/ledger.service';
import { CommissionService } from '../finance/commission.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import {
  assertBookingAccess,
  assertVenueAccess,
} from '../../common/access/owner-access';
import { ApiException } from '../../common/errors/api-exception';
import { isBookingSlotConflict } from '../../common/utils/booking-slot-conflict.util';
import { maskPlayerPhone, normalizeOptionalPhone } from '../../common/utils/phone.util';
import { quoteDurationPrice } from '../../common/utils/price-quote.util';
import {
  assertCustomSourceLabel,
  isPresetSourceKey,
  normalizeSourceLabel,
  SOURCE_PRESETS,
  sourceDisplay,
} from '../../common/utils/source-label.util';
import { zonedHhmm, zonedWeekday } from '../../common/utils/timezone.util';
import {
  isTimeWithinDayHours,
  type WeeklyHours,
} from '../../common/utils/weekly-hours.util';
import {
  CreateManualBookingDto,
  UpdateManualBookingDto,
} from './dto/manual-booking.dto';
import { CreateWalkInDto } from './dto/walk-in.dto';
import { formatMoney, notifyFinance } from '../finance/finance-notify';

const NINETY_DAYS_MS = 90 * 86_400_000;

function mapPaymentMethod(
  method?: string,
): PaymentMethod {
  if (method === 'instapay' || method === 'wallet' || method === 'card' || method === 'cash') {
    return method;
  }
  return 'cash';
}

function mapPaymentStatus(
  status?: 'paid' | 'unpaid' | 'partial',
): PaymentStatus {
  if (status === 'unpaid') return 'pending';
  if (status === 'partial') return 'partial';
  return 'paid';
}

function generateManualCode(): string {
  return `MAN-${randomBytes(5).toString('hex').slice(0, 8).toUpperCase()}`;
}

@Injectable()
export class OwnerBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly commission: CommissionService,
    private readonly notifications: NotificationsService,
  ) {}

  async createManualBooking(
    user: AuthenticatedUser,
    dto: CreateManualBookingDto,
  ) {
    const venue = await assertVenueAccess(this.prisma, user, dto.venueId, {
      write: true,
    });
    if (dto.durationMinutes % 15 !== 0) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'INVALID_DURATION', 'Duration must be a multiple of 15 minutes');
    }
    const court = await this.prisma.court.findUnique({
      where: { id: dto.courtId },
      include: { sport: { select: { activityKind: true } } },
    });
    if (!court || court.venueId !== dto.venueId) {
      throw new BadRequestException('Court does not belong to this venue');
    }
    const slotStart = new Date(dto.startsAt);
    const slotEnd = new Date(slotStart.getTime() + dto.durationMinutes * 60_000);
    if (dto.paymentStatus === 'partial') {
      if (!dto.paidAmount || dto.paidAmount <= 0 || dto.paidAmount >= dto.priceAmount) {
        throw new BadRequestException('paidAmount is required and must be between 0 and priceAmount');
      }
    }
    let sourceKey = dto.sourceKey;
    let sourceLabel = dto.sourceLabel?.trim() || null;
    if (sourceLabel) {
      try {
        sourceLabel = assertCustomSourceLabel(sourceLabel);
      } catch {
        throw new BadRequestException('Invalid source label');
      }
    } else if (!sourceKey) {
      sourceKey = 'walk_in';
    }

    const warnings: string[] = [];
    const weeklyHours = venue.weeklyHours as WeeklyHours | null;
    const timeZone = await this.venueTz(dto.venueId);
    if (weeklyHours) {
      for (let t = slotStart.getTime(); t < slotEnd.getTime(); t += 15 * 60_000) {
        const instant = new Date(t);
        const day = zonedWeekday(instant, timeZone);
        const hours = weeklyHours[String(day)] ?? weeklyHours[day as unknown as string];
        if (!isTimeWithinDayHours(zonedHhmm(instant, timeZone), hours)) {
          warnings.push('OUTSIDE_HOURS');
          break;
        }
      }
    }

    try {
      const booking = await this.prisma.$transaction(
        async (tx) => {
          await this.assertSlotFree(tx, dto.courtId, dto.venueId, slotStart, slotEnd);
          let code = generateManualCode();
          for (let i = 0; i < 5; i++) {
            const clash = await tx.booking.findUnique({ where: { code } });
            if (!clash) break;
            code = generateManualCode();
          }
          const paymentStatus = mapPaymentStatus(dto.paymentStatus);
          const paymentMethod = mapPaymentMethod(dto.paymentMethod);
          const created = await tx.booking.create({
            data: {
              code,
              courtId: dto.courtId,
              venueId: dto.venueId,
              userId: user.id,
              slotStart,
              slotEnd,
              baseAmount: dto.priceAmount,
              feeAmount: 0,
              discountAmount: 0,
              totalAmount: dto.priceAmount,
              status: 'confirmed',
              paymentStatus,
              paymentMethod,
              guestName: dto.customerName?.trim() || null,
              guestPhone: normalizeOptionalPhone(dto.customerPhone) ?? null,
              source: 'manual',
              sourceKey: sourceLabel ? null : (sourceKey ?? 'walk_in'),
              sourceLabel,
              notes: dto.notes?.trim() || null,
              createdByUserId: user.id,
            },
          });
          const paidNow =
            paymentStatus === 'paid'
              ? dto.priceAmount
              : paymentStatus === 'partial'
                ? dto.paidAmount!
                : 0;
          if (paidNow > 0) {
            await tx.payment.create({
              data: {
                bookingId: created.id,
                amount: paidNow,
                currency: created.currency,
                method: paymentMethod,
                status: 'paid',
              },
            });
          }
          if (sourceLabel) {
            await this.touchCustomSource(tx, dto.venueId, sourceLabel);
          }
          await this.ledger.syncBookingLedger(tx, created.id);
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return { ...(await this.toOwnerBookingDto(booking)), warnings };
    } catch (error) {
      if (error instanceof ConflictException || error instanceof ApiException) throw error;
      if (isBookingSlotConflict(error)) {
        throw new ConflictException({ code: 'SLOT_ALREADY_HELD', message: 'Slot already held' });
      }
      throw error;
    }
  }

  /** @deprecated thin alias of createManualBooking */
  async createWalkInAlias(user: AuthenticatedUser, dto: CreateWalkInDto) {
    const startsAt = new Date(dto.slotStart);
    const endsAt = new Date(dto.slotEnd);
    const durationMinutes = Math.max(
      15,
      Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000 / 15) * 15,
    );
    return this.createManualBooking(user, {
      venueId: dto.venueId,
      courtId: dto.courtId,
      startsAt: dto.slotStart,
      durationMinutes,
      priceAmount: dto.priceAmount ?? 0,
      paymentStatus: 'paid',
      paymentMethod: 'cash',
      customerName: dto.customerName,
      customerPhone: dto.customerPhone,
      sourceKey: 'walk_in',
    });
  }

  async updateManualBooking(
    user: AuthenticatedUser,
    bookingId: string,
    dto: UpdateManualBookingDto,
  ) {
    const { booking } = await assertBookingAccess(this.prisma, user, bookingId, {
      write: true,
    });
    if (booking.source === 'platform') {
      throw new ApiException(HttpStatus.FORBIDDEN, 'PLATFORM_BOOKING_LOCKED', 'Matchena bookings cannot be edited');
    }
    if (booking.status === 'cancelled') {
      throw new BadRequestException('Restore the booking before editing');
    }
    if (Date.now() - booking.slotStart.getTime() > NINETY_DAYS_MS) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'BOOKING_TOO_OLD', 'Bookings older than 90 days cannot be edited');
    }
    const courtId = dto.courtId ?? booking.courtId;
    const slotStart = dto.startsAt ? new Date(dto.startsAt) : booking.slotStart;
    const durationMinutes = dto.durationMinutes
      ?? Math.round((booking.slotEnd.getTime() - booking.slotStart.getTime()) / 60_000);
    if (durationMinutes % 15 !== 0) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'INVALID_DURATION', 'Duration must be a multiple of 15 minutes');
    }
    const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000);
    if (dto.courtId) {
      const court = await this.prisma.court.findUnique({ where: { id: dto.courtId } });
      if (!court || court.venueId !== booking.venueId) {
        throw new BadRequestException('Court does not belong to this venue');
      }
    }

    const changed: Record<string, [unknown, unknown]> = {};
    const next: Prisma.BookingUpdateInput = {};
    const assign = (field: string, from: unknown, to: unknown, data: Prisma.BookingUpdateInput) => {
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        changed[field] = [from, to];
        Object.assign(next, data);
      }
    };
    assign('courtId', booking.courtId, courtId, { court: { connect: { id: courtId } } });
    assign('slotStart', booking.slotStart.toISOString(), slotStart.toISOString(), { slotStart, slotEnd });
    if (dto.priceAmount != null) {
      assign('priceAmount', booking.totalAmount, dto.priceAmount, {
        baseAmount: dto.priceAmount,
        totalAmount: dto.priceAmount,
      });
    }
    if (dto.paymentStatus) {
      const mapped = mapPaymentStatus(dto.paymentStatus);
      assign('paymentStatus', booking.paymentStatus, mapped, { paymentStatus: mapped });
    }
    if (dto.paymentMethod) {
      assign('paymentMethod', booking.paymentMethod, mapPaymentMethod(dto.paymentMethod), {
        paymentMethod: mapPaymentMethod(dto.paymentMethod),
      });
    }
    if (dto.customerName !== undefined) {
      assign('guestName', booking.guestName, dto.customerName, { guestName: dto.customerName });
    }
    if (dto.customerPhone !== undefined) {
      assign('guestPhone', booking.guestPhone, dto.customerPhone, {
        guestPhone: normalizeOptionalPhone(dto.customerPhone) ?? null,
      });
    }
    if (dto.notes !== undefined) assign('notes', booking.notes, dto.notes, { notes: dto.notes });
    let customLabel: string | undefined;
    if (dto.sourceLabel) {
      try {
        customLabel = assertCustomSourceLabel(dto.sourceLabel);
      } catch {
        throw new BadRequestException('Invalid source label');
      }
      assign('sourceLabel', booking.sourceLabel, customLabel, { sourceLabel: customLabel, sourceKey: null });
    } else if (dto.sourceKey) {
      assign('sourceKey', booking.sourceKey, dto.sourceKey, { sourceKey: dto.sourceKey, sourceLabel: null });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.assertSlotFree(tx, courtId, booking.venueId, slotStart, slotEnd, booking.id);
      const row = await tx.booking.update({ where: { id: bookingId }, data: next });
      if (customLabel) await this.touchCustomSource(tx, booking.venueId, customLabel);
      await tx.auditLogEntry.create({
        data: {
          actorUserId: user.id,
          action: 'owner.booking.updated',
          targetType: 'booking',
          targetId: bookingId,
          metadata: { bookingId, venueId: booking.venueId, changed } as Prisma.InputJsonValue,
        },
      });
      await this.ledger.syncBookingLedger(tx, bookingId);
      return row;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return this.toOwnerBookingDto(updated);
  }

  async deleteManualBooking(user: AuthenticatedUser, bookingId: string) {
    const { booking } = await assertBookingAccess(this.prisma, user, bookingId, { write: true });
    if (booking.source === 'platform') {
      throw new ApiException(HttpStatus.FORBIDDEN, 'PLATFORM_BOOKING_LOCKED', 'Matchena bookings cannot be deleted');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancellationReason: 'deleted_by_owner',
        },
      });
      await this.ledger.syncBookingLedger(tx, bookingId, 'cancelled');
      return row;
    });
    return this.toOwnerBookingDto(updated);
  }

  async restoreManualBooking(user: AuthenticatedUser, bookingId: string) {
    const { booking } = await assertBookingAccess(this.prisma, user, bookingId, { write: true });
    if (booking.source === 'platform') {
      throw new ApiException(HttpStatus.FORBIDDEN, 'PLATFORM_BOOKING_LOCKED', 'Matchena bookings cannot be restored');
    }
    if (booking.status !== 'cancelled') {
      throw new BadRequestException('Only cancelled bookings can be restored');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.assertSlotFree(
        tx,
        booking.courtId,
        booking.venueId,
        booking.slotStart,
        booking.slotEnd,
        booking.id,
      );
      const row = await tx.booking.update({
        where: { id: bookingId },
        data: { status: 'confirmed', cancelledAt: null, cancellationReason: null },
      });
      await this.ledger.syncBookingLedger(tx, bookingId);
      return row;
    });
    return this.toOwnerBookingDto(updated);
  }

  async addManualPayment(
    user: AuthenticatedUser,
    bookingId: string,
    amount: number,
    method?: string,
  ) {
    const { booking } = await assertBookingAccess(this.prisma, user, bookingId, { write: true });
    if (booking.source === 'platform') {
      throw new ApiException(HttpStatus.FORBIDDEN, 'PLATFORM_BOOKING_LOCKED', 'Matchena bookings cannot take owner payments');
    }
    const paid = await this.prisma.payment.aggregate({
      where: { bookingId, status: 'paid' },
      _sum: { amount: true },
    });
    const already = paid._sum.amount ?? 0;
    if (already + amount > booking.totalAmount) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'OVERPAYMENT', 'Payment exceeds remaining balance');
    }
    const nextPaid = already + amount;
    const paymentStatus: PaymentStatus =
      nextPaid >= booking.totalAmount ? 'paid' : 'partial';
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          bookingId,
          amount,
          currency: booking.currency,
          method: mapPaymentMethod(method),
          status: 'paid',
        },
      });
      await tx.booking.update({
        where: { id: bookingId },
        data: { paymentStatus, paymentMethod: mapPaymentMethod(method) },
      });
    });
    return this.toOwnerBookingDto(
      await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }),
    );
  }

  async listSources(user: AuthenticatedUser, venueId: string) {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const custom = await this.prisma.venueBookingSource.findMany({
      where: { venueId },
      orderBy: [{ useCount: 'desc' }, { lastUsedAt: 'desc' }],
      take: 20,
    });
    return { presets: SOURCE_PRESETS, custom };
  }

  async deleteSource(user: AuthenticatedUser, venueId: string, id: string) {
    await assertVenueAccess(this.prisma, user, venueId, { write: true });
    const row = await this.prisma.venueBookingSource.findUnique({ where: { id } });
    if (!row || row.venueId !== venueId) throw new NotFoundException('Source not found');
    await this.prisma.venueBookingSource.delete({ where: { id } });
    return { ok: true };
  }

  async priceQuote(
    user: AuthenticatedUser,
    venueId: string,
    courtId: string,
    startsAt: string,
    durationMinutes: number,
  ) {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    if (!durationMinutes || durationMinutes % 15 !== 0) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'INVALID_DURATION', 'Duration must be a multiple of 15 minutes');
    }
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { pricingRules: true, venue: { include: { country: true } } },
    });
    if (!court || court.venueId !== venueId) {
      throw new BadRequestException('Court does not belong to this venue');
    }
    const tz = court.venue.country.timezone;
    return quoteDurationPrice(
      court.pricingRules,
      new Date(startsAt),
      durationMinutes,
      tz,
    );
  }

  async listReportBookings(
    user: AuthenticatedUser,
    query: {
      venueId: string;
      from?: string;
      to?: string;
      source?: string;
      status?: string;
      courtId?: string;
      paymentStatus?: string;
      q?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    await assertVenueAccess(this.prisma, user, query.venueId, { write: false });
    const limit = Math.min(query.limit ?? 30, 100);
    const where: Prisma.BookingWhereInput = { venueId: query.venueId };
    if (query.from || query.to) {
      where.slotStart = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    if (query.status) where.status = query.status as Booking['status'];
    if (query.courtId) where.courtId = query.courtId;
    if (query.paymentStatus) where.paymentStatus = query.paymentStatus as Booking['paymentStatus'];
    if (query.source === 'platform' || query.source === 'manual') {
      where.source = query.source;
    } else if (query.source && isPresetSourceKey(query.source)) {
      where.source = 'manual';
      where.sourceKey = query.source;
    } else if (query.source) {
      where.source = 'manual';
      where.sourceLabel = query.source;
    }
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { code: { contains: q, mode: 'insensitive' } },
        { guestName: { contains: q, mode: 'insensitive' } },
        { guestPhone: { contains: q } },
      ];
    }
    const rows = await this.prisma.booking.findMany({
      where,
      include: {
        court: { include: { sport: { select: { activityKind: true, nameEn: true, nameAr: true } } } },
        user: { select: { id: true, name: true, phone: true } },
        payments: { where: { status: 'paid' }, select: { amount: true } },
      },
      orderBy: [{ slotStart: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((b) => this.mapLoaded(b)),
      nextCursor: hasMore ? page[page.length - 1].id : undefined,
    };
  }

  async attention(user: AuthenticatedUser, venueId: string) {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const now = new Date();
    const windowStart = new Date(now.getTime() - 24 * 3_600_000);
    const needsArrival = await this.prisma.booking.findMany({
      where: {
        venueId,
        source: 'platform',
        status: 'confirmed',
        checkedInAt: null,
        slotEnd: { gte: windowStart, lte: now },
      },
      include: {
        court: { include: { sport: { select: { activityKind: true } } } },
        user: { select: { id: true, name: true, phone: true } },
        payments: true,
      },
      orderBy: { slotEnd: 'asc' },
    });
    const unpaid = await this.prisma.booking.findMany({
      where: {
        venueId,
        source: 'manual',
        status: { not: 'cancelled' },
        paymentStatus: { in: ['pending', 'partial'] },
        slotStart: { gte: windowStart },
      },
      include: {
        court: { include: { sport: { select: { activityKind: true } } } },
        user: { select: { id: true, name: true, phone: true } },
        payments: true,
      },
      orderBy: { slotStart: 'asc' },
    });
    return {
      arrival: needsArrival.map((b) => this.mapLoaded(b)),
      unpaid: unpaid.map((b) => this.mapLoaded(b)),
    };
  }

  async createRemittance(
    user: AuthenticatedUser,
    dto: {
      venueId: string;
      amount: number;
      method: string;
      reference?: string;
      note?: string;
      receiptUrl?: string;
    },
  ) {
    const venue = await assertVenueAccess(this.prisma, user, dto.venueId, { write: true });
    const currency = venue.priceFromCurrency ?? 'EGP';
    if (dto.receiptUrl && !isSafeReceiptUrl(dto.receiptUrl, process.env.S3_PUBLIC_BASE)) {
      throw new BadRequestException('receiptUrl must point to Matchena storage');
    }
    const settlement = await this.prisma.venueSettlement.create({
      data: {
        venueId: dto.venueId,
        direction: 'owner_to_platform',
        amount: dto.amount,
        currency,
        method: dto.method,
        reference: dto.reference,
        note: dto.note,
        receiptUrl: dto.receiptUrl,
        status: 'pending_confirmation',
        recordedById: user.id,
      },
    });
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: 'admin' } },
      select: { id: true },
    });
    await Promise.all(
      admins.map((admin) =>
        notifyFinance(this.notifications, {
          userId: admin.id,
          titleEn: `${venue.nameEn} submitted ${formatMoney(dto.amount, currency)}`,
          titleAr: `${venue.nameAr} بعتت ${formatMoney(dto.amount, currency, 'ar')}`,
          bodyEn: 'Waiting for confirmation. No ledger change yet.',
          bodyAr: 'في انتظار التأكيد. مفيش تغيير في الحساب لسه.',
          payload: { venueId: dto.venueId, settlementId: settlement.id },
        }).catch(() => undefined),
      ),
    );
    return settlement;
  }

  async cancelRemittance(user: AuthenticatedUser, id: string) {
    const settlement = await this.prisma.venueSettlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundException('Remittance not found');
    await assertVenueAccess(this.prisma, user, settlement.venueId, { write: true });
    if (settlement.status !== 'pending_confirmation') {
      throw new BadRequestException('Only pending remittances can be cancelled');
    }
    if (settlement.recordedById !== user.id && !user.roles.includes('owner')) {
      throw new BadRequestException('You can only cancel your own remittance');
    }
    return this.prisma.venueSettlement.update({
      where: { id },
      data: { status: 'rejected', rejectionReason: 'cancelled_by_owner' },
    });
  }

  async getMatchenaAccount(user: AuthenticatedUser, venueId: string) {
    const venue = await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const currency = venue.priceFromCurrency ?? 'EGP';
    const [balance, commission, pending, settlements, entries] = await Promise.all([
      this.ledger.getBalance(venueId, currency),
      this.commission.resolveSource(venueId),
      this.prisma.venueSettlement.count({
        where: { venueId, status: 'pending_confirmation' },
      }),
      this.prisma.venueSettlement.findMany({
        where: { venueId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.ledger.listEntries(venueId, { limit: 20 }),
    ]);
    const balanceExplanation =
      balance > 0 ? 'MATCHENA_OWES_YOU' : balance < 0 ? 'YOU_OWE_MATCHENA' : 'SETTLED';
    return {
      venueId,
      currency,
      balance,
      commissionBps: commission.bps,
      commissionSource: commission.source,
      paymentMode: venue.paymentMode,
      pendingRemittances: pending,
      lastSettlements: settlements,
      entries: entries.items,
      nextCursor: entries.nextCursor,
      balanceExplanation,
    };
  }

  async toOwnerBookingDto(booking: Booking) {
    const loaded = await this.prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: {
        court: { include: { sport: { select: { activityKind: true } } } },
        user: { select: { id: true, name: true, phone: true } },
        payments: { where: { status: 'paid' }, select: { amount: true } },
      },
    });
    return this.mapLoaded(loaded);
  }

  private mapLoaded(b: {
    id: string;
    code: string;
    venueId: string;
    courtId: string;
    slotStart: Date;
    slotEnd: Date;
    status: Booking['status'];
    source: Booking['source'];
    sourceKey: string | null;
    sourceLabel: string | null;
    guestName: string | null;
    guestPhone: string | null;
    userId: string;
    user?: { id: string; name: string; phone: string | null } | null;
    court?: { name: string; sport?: { activityKind: string | null } | null } | null;
    totalAmount: number;
    baseAmount: number;
    feeAmount: number;
    commissionAmount: number | null;
    ownerNetAmount: number | null;
    paymentStatus: Booking['paymentStatus'];
    paymentMethod: Booking['paymentMethod'];
    notes: string | null;
    checkedInAt: Date | null;
    currency: string;
    payments?: { amount: number }[];
  }) {
    const durationMinutes = Math.round((b.slotEnd.getTime() - b.slotStart.getTime()) / 60_000);
    const paidAmount = (b.payments ?? []).reduce((s, p) => s + p.amount, 0);
    const isLocked = b.source === 'platform';
    const tooOld = Date.now() - b.slotStart.getTime() > NINETY_DAYS_MS;
    const display = sourceDisplay(b.source, b.sourceKey, b.sourceLabel);
    const needsAttention =
      isLocked &&
      b.status === 'confirmed' &&
      !b.checkedInAt &&
      b.slotEnd <= new Date() &&
      b.slotEnd >= new Date(Date.now() - 24 * 3_600_000);
    return {
      id: b.id,
      code: b.code,
      venueId: b.venueId,
      courtId: b.courtId,
      courtName: b.court?.name,
      unitKind: b.court?.sport?.activityKind ?? null,
      startsAt: b.slotStart.toISOString(),
      endsAt: b.slotEnd.toISOString(),
      durationMinutes,
      status: b.status,
      source: b.source,
      sourceKey: b.sourceKey,
      sourceLabel: display.label,
      customer: {
        name: b.source === 'manual' ? b.guestName : b.user?.name,
        phoneMasked: b.source === 'platform' ? maskPlayerPhone(b.user?.phone) : null,
        phone: b.source === 'manual' ? b.guestPhone : undefined,
        userId: b.source === 'platform' ? b.userId : undefined,
      },
      money: {
        total: b.totalAmount,
        base: b.baseAmount,
        commissionAmount: isLocked ? b.commissionAmount : undefined,
        ownerNet: isLocked ? b.ownerNetAmount : undefined,
        paidAmount,
        outstanding: Math.max(0, b.totalAmount - paidAmount),
        currency: b.currency,
      },
      paymentStatus: b.paymentStatus,
      paymentMethod: b.paymentMethod,
      notes: b.notes,
      checkedInAt: b.checkedInAt?.toISOString() ?? null,
      isLocked,
      canEdit: !isLocked && !tooOld && b.status !== 'cancelled',
      needsAttention,
    };
  }

  private async assertSlotFree(
    tx: Prisma.TransactionClient,
    courtId: string,
    venueId: string,
    slotStart: Date,
    slotEnd: Date,
    excludeId?: string,
  ) {
    const overlap = await tx.booking.findFirst({
      where: {
        courtId,
        status: { in: ['held', 'confirmed'] },
        slotStart: { lt: slotEnd },
        slotEnd: { gt: slotStart },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    if (overlap) {
      throw new ConflictException({ code: 'SLOT_ALREADY_HELD', message: 'Slot already held' });
    }
    const blocked = await tx.calendarBlock.findFirst({
      where: {
        venueId,
        OR: [{ courtId }, { courtId: null }],
        startsAt: { lt: slotEnd },
        endsAt: { gt: slotStart },
      },
    });
    if (blocked) {
      throw new ConflictException({ code: 'SLOT_BLOCKED', message: 'Slot is blocked' });
    }
  }

  private async touchCustomSource(
    tx: Prisma.TransactionClient,
    venueId: string,
    label: string,
  ) {
    const normalized = normalizeSourceLabel(label);
    await tx.venueBookingSource.upsert({
      where: { venueId_normalized: { venueId, normalized } },
      create: { venueId, label, normalized, useCount: 1, lastUsedAt: new Date() },
      update: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    });
  }

  private async venueTz(venueId: string): Promise<string> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { country: { select: { timezone: true } } },
    });
    return venue?.country?.timezone ?? 'Africa/Cairo';
  }
}
