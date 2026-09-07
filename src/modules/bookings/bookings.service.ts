import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Booking, BookingStatus, Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { HoldSlotDto } from './dto/hold-slot.dto';
import { ConfirmBookingDto } from './dto/confirm-booking.dto';
import { CreateRecurringSeriesDto } from './dto/recurring-booking.dto';
import { signQrPayload, verifyQrPayload } from '../../common/utils/qr.util';
import {
  zonedDayBounds,
  zonedHhmm,
  zonedWeekday,
} from '../../common/utils/timezone.util';
import {
  isTimeWithinDayHours,
  WeeklyHours,
} from '../../common/utils/weekly-hours.util';
import { isBookingSlotConflict } from '../../common/utils/booking-slot-conflict.util';
import { matchPricingRule } from '../../common/utils/pricing-rule.util';
import { assertVenueStaffAccess } from '../../common/access/venue-access';
import { randomUUID } from 'crypto';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
} from '../payments/payment-provider.interface';

const HOLD_DURATION_MS = 2 * 60 * 1000; // 2 minutes, per §19.4's "60-120 seconds" guidance
const FIRST_BOOKING_BONUS_COINS = 200;

export interface SlotCell {
  start: string;
  end: string;
  priceAmount: number;
  currency: string;
  state: 'available' | 'booked' | 'held' | 'past' | 'blocked';
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
  ) {}

  // ---------- Slot grid ----------

  async getSlotGrid(courtId: string, dateStr: string): Promise<SlotCell[]> {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: {
        pricingRules: true,
        venue: { include: { country: true } },
      },
    });
    if (!court) throw new NotFoundException('Court not found');

    const timeZone = court.venue.country.timezone;
    const {
      start: dayStart,
      end: dayEnd,
      dayOfWeek,
    } = zonedDayBounds(dateStr, timeZone);

    const existing = await this.prisma.booking.findMany({
      where: {
        courtId,
        slotStart: { gte: dayStart, lt: dayEnd },
        status: { in: ['held', 'confirmed'] },
      },
    });
    const blocks = await this.prisma.calendarBlock.findMany({
      where: {
        venueId: court.venueId,
        OR: [{ courtId: court.id }, { courtId: null }],
        startsAt: { lt: dayEnd },
        endsAt: { gt: dayStart },
      },
    });
    const weeklyHours = court.venue.weeklyHours as WeeklyHours | null;
    const dayHours = weeklyHours
      ? (weeklyHours[String(dayOfWeek)] ??
        weeklyHours[dayOfWeek as unknown as string])
      : undefined;

    const cells: SlotCell[] = [];
    const now = new Date();
    for (
      let cursor = new Date(dayStart);
      cursor < dayEnd;
      cursor.setMinutes(cursor.getMinutes() + court.slotDurationMins)
    ) {
      const start = new Date(cursor);
      const end = new Date(start.getTime() + court.slotDurationMins * 60_000);
      if (
        weeklyHours &&
        !isTimeWithinDayHours(zonedHhmm(start, timeZone), dayHours)
      ) {
        continue;
      }
      const rule = matchPricingRule(
        court.pricingRules,
        dayOfWeek,
        start,
        timeZone,
      );
      const overlapping = existing.find(
        (b) => b.slotStart.getTime() === start.getTime(),
      );
      const blocked = blocks.some((b) => b.startsAt < end && b.endsAt > start);

      let state: SlotCell['state'] = 'available';
      if (start < now) state = 'past';
      else if (blocked) state = 'blocked';
      else if (overlapping?.status === 'confirmed') state = 'booked';
      else if (overlapping?.status === 'held') state = 'held';

      cells.push({
        start: start.toISOString(),
        end: end.toISOString(),
        priceAmount: rule?.priceAmount ?? 0,
        currency: rule?.currency ?? court.venue.country.currency,
        state,
      });
    }
    return cells;
  }

  // ---------- Hold -> confirm (the money path) ----------

  async holdSlot(userId: string, dto: HoldSlotDto): Promise<Booking> {
    const court = await this.prisma.court.findUnique({
      where: { id: dto.courtId },
      include: { pricingRules: true, venue: { include: { country: true } } },
    });
    if (!court) throw new NotFoundException('Court not found');

    const slotStart = new Date(dto.slotStart);
    if (slotStart < new Date())
      throw new BadRequestException('Cannot book a past slot');

    const timeZone = court.venue.country.timezone;
    const rule = matchPricingRule(
      court.pricingRules,
      zonedWeekday(slotStart, timeZone),
      slotStart,
      timeZone,
    );
    if (!rule)
      throw new BadRequestException('This court has no pricing configured');
    const units = dto.units ?? 1;
    const slotEnd = new Date(
      slotStart.getTime() + court.slotDurationMins * units * 60_000,
    );

    const weeklyHours = court.venue.weeklyHours as WeeklyHours | null;
    if (weeklyHours) {
      const dayOfWeek = zonedWeekday(slotStart, timeZone);
      const dayHours =
        weeklyHours[String(dayOfWeek)] ??
        weeklyHours[dayOfWeek as unknown as string];
      if (!isTimeWithinDayHours(zonedHhmm(slotStart, timeZone), dayHours)) {
        throw new BadRequestException('SLOT_OUTSIDE_HOURS');
      }
    }

    const platformSetting = await this.prisma.platformSetting.findUnique({
      where: { id: 1 },
    });
    const feePct =
      court.venue.country.serviceFeePct ?? platformSetting?.serviceFeePct ?? 5;
    const baseAmount = rule.priceAmount * units;
    const feeAmount = Math.round(baseAmount * (feePct / 100));

    let discountAmount = 0;
    let promoCodeId: string | undefined;
    if (dto.promoCode) {
      const promo = await this.validatePromo(dto.promoCode, userId, baseAmount);
      discountAmount = promo.discountAmount;
      promoCodeId = promo.id;
    }

    let coinsRedeemed = 0;
    if (dto.coinsToRedeem) {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      coinsRedeemed = Math.min(dto.coinsToRedeem, user.coinsBalance);
      const coinRate =
        court.venue.country.coinToMajorRate ??
        platformSetting?.coinToEgpRate ??
        20;
      discountAmount += Math.round((coinsRedeemed / coinRate) * 100);
    }

    const totalAmount = Math.max(0, baseAmount + feeAmount - discountAmount);

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const blocked = await tx.calendarBlock.findFirst({
            where: {
              venueId: court.venueId,
              OR: [{ courtId: court.id }, { courtId: null }],
              startsAt: { lt: slotEnd },
              endsAt: { gt: slotStart },
            },
          });
          if (blocked) throw new ConflictException('SLOT_BLOCKED');

          const overlap = await tx.booking.findFirst({
            where: {
              courtId: court.id,
              status: { in: ['held', 'confirmed'] },
              slotStart: { lt: slotEnd },
              slotEnd: { gt: slotStart },
            },
          });
          if (overlap) throw new ConflictException('SLOT_ALREADY_HELD');

          return tx.booking.create({
            data: {
              code: this.generateBookingCode(),
              courtId: court.id,
              venueId: court.venueId,
              userId,
              slotStart,
              slotEnd,
              baseAmount,
              feeAmount,
              discountAmount,
              totalAmount,
              currency: rule.currency ?? court.venue.country.currency,
              promoCodeId,
              coinsRedeemed,
              status: 'held',
              holdExpiresAt: new Date(Date.now() + HOLD_DURATION_MS),
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

  private async validatePromo(
    code: string,
    userId: string,
    baseAmount: number,
  ) {
    const promo = await this.prisma.promoCode.findUnique({ where: { code } });
    if (!promo || !promo.active)
      throw new BadRequestException('Invalid promo code');
    const now = new Date();
    if (now < promo.validFrom || now > promo.validUntil)
      throw new BadRequestException('Promo code expired');
    if (promo.minBookingAmount && baseAmount < promo.minBookingAmount) {
      throw new BadRequestException(
        'Booking amount is below this promo code minimum',
      );
    }

    const redemptionCount = await this.prisma.promoRedemption.count({
      where: { promoCodeId: promo.id, userId },
    });
    if (redemptionCount >= promo.usageLimitPerUser)
      throw new BadRequestException('Promo code already used');

    if (promo.usageLimitTotal) {
      const total = await this.prisma.promoRedemption.count({
        where: { promoCodeId: promo.id },
      });
      if (total >= promo.usageLimitTotal)
        throw new BadRequestException('Promo code fully redeemed');
    }

    if (promo.firstBookingOnly) {
      const priorBookings = await this.prisma.booking.count({
        where: { userId, status: { in: ['confirmed', 'completed'] } },
      });
      if (priorBookings > 0)
        throw new BadRequestException('This promo is for first bookings only');
    }

    const discountAmount =
      promo.type === 'percentage'
        ? Math.round((baseAmount * promo.value) / 100)
        : promo.value;

    return {
      id: promo.id,
      code: promo.code,
      type: promo.type,
      value: promo.value,
      discountAmount: Math.min(discountAmount, baseAmount),
    };
  }

  async previewPromo(code: string, userId: string, amount: number) {
    return this.validatePromo(code, userId, amount);
  }

  private generateBookingCode(): string {
    return `MAL-${randomUUID().slice(0, 8).toUpperCase()}`;
  }

  async confirmBooking(
    userId: string,
    bookingId: string,
    dto: ConfirmBookingDto,
  ): Promise<Booking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { venue: { include: { country: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.userId !== userId)
      throw new ForbiddenException('Not your booking');
    if (booking.status !== 'held')
      throw new BadRequestException('Booking is not in a holdable state');
    if (!booking.holdExpiresAt || booking.holdExpiresAt < new Date()) {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: { status: 'cancelled' },
      });
      throw new ConflictException('PULSE_EXPIRED');
    }

    const allowed = booking.venue.country.paymentMethods;
    if (!allowed.includes(dto.paymentMethod)) {
      throw new BadRequestException(
        `Payment method not available in ${booking.venue.country.code}`,
      );
    }

    const isSplit = !!dto.splitShares?.length;
    let chargeAmount = booking.totalAmount;
    if (isSplit) {
      const shares = dto.splitShares!;
      for (const share of shares) {
        if (!share.userId && !share.phone) {
          throw new BadRequestException(
            'Each split share needs a userId or phone',
          );
        }
      }
      const sum = shares.reduce((acc, share) => acc + share.amount, 0);
      if (sum !== booking.totalAmount) {
        throw new BadRequestException('SPLIT_AMOUNT_MISMATCH');
      }
      const organizerShare = shares.find((s) => s.userId === userId);
      if (!organizerShare) {
        throw new BadRequestException('SPLIT_ORGANIZER_SHARE_REQUIRED');
      }
      chargeAmount = organizerShare.amount;
    }

    const charge = await this.paymentProvider.charge(
      chargeAmount,
      booking.currency,
      dto.paymentMethod,
    );
    if (charge.status === 'failed') {
      throw new BadRequestException('PAYMENT_FAILED');
    }
    const paymentStatus =
      charge.status === 'pending' ? 'pending' : isSplit ? 'partial' : 'paid';
    const qrPayload = signQrPayload(
      bookingId,
      this.config.get<string>('QR_SIGNING_SECRET')!,
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (booking.coinsRedeemed > 0) {
          const spent = await tx.user.updateMany({
            where: {
              id: userId,
              coinsBalance: { gte: booking.coinsRedeemed },
            },
            data: { coinsBalance: { decrement: booking.coinsRedeemed } },
          });
          if (spent.count !== 1) {
            throw new BadRequestException('INSUFFICIENT_COINS');
          }
          await tx.coinLedgerEntry.create({
            data: {
              userId,
              amount: -booking.coinsRedeemed,
              reason: 'booking_redemption',
              bookingId,
            },
          });
        }

        const confirmed = await tx.booking.updateMany({
          where: { id: bookingId, status: 'held' },
          data: {
            status: 'confirmed',
            holdExpiresAt: null,
            paymentMethod: dto.paymentMethod,
            paymentStatus,
            isSplitPayment: isSplit,
            qrPayload,
          },
        });
        if (confirmed.count !== 1) {
          throw new ConflictException('PULSE_EXPIRED');
        }

        await tx.payment.create({
          data: {
            bookingId,
            amount: chargeAmount,
            currency: booking.currency,
            method: dto.paymentMethod,
            status: charge.status,
            providerRef: charge.providerRef,
          },
        });
        if (booking.promoCodeId) {
          await tx.promoRedemption.create({
            data: { promoCodeId: booking.promoCodeId, userId, bookingId },
          });
        }
        if (isSplit) {
          await tx.bookingSplitShare.createMany({
            data: dto.splitShares!.map((s) => ({
              bookingId,
              userId: s.userId,
              phone: s.phone,
              amount: s.amount,
              currency: booking.currency,
              status:
                s.userId === userId && charge.status === 'paid'
                  ? 'paid'
                  : 'pending',
            })),
          });
        }
        return tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
      });
    } catch (error) {
      if (charge.status === 'paid') {
        await this.paymentProvider.refund(
          chargeAmount,
          booking.currency,
          charge.providerRef,
        );
      }
      throw error;
    }
  }

  // ---------- Split payment ----------

  async paySplitShare(shareLinkToken: string, payerUserId?: string) {
    const share = await this.prisma.bookingSplitShare.findUnique({
      where: { shareLinkToken },
      include: { booking: { select: { currency: true, paymentMethod: true } } },
    });
    if (!share) throw new NotFoundException('Share link not found');
    const { booking, ...shareRow } = share;
    if (shareRow.status === 'paid') return shareRow;

    const charge = await this.paymentProvider.charge(
      shareRow.amount,
      shareRow.currency,
      booking.paymentMethod ?? 'card',
    );
    if (charge.status === 'failed') {
      throw new BadRequestException('PAYMENT_FAILED');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.bookingSplitShare.update({
          where: { id: shareRow.id },
          data: {
            status: charge.status === 'paid' ? 'paid' : shareRow.status,
            userId: shareRow.userId ?? payerUserId,
          },
        });
        if (charge.status === 'paid') {
          await tx.payment.create({
            data: {
              bookingId: shareRow.bookingId,
              amount: shareRow.amount,
              currency: shareRow.currency,
              method: booking.paymentMethod ?? 'card',
              status: 'paid',
              providerRef: charge.providerRef,
            },
          });
          const shares = await tx.bookingSplitShare.findMany({
            where: { bookingId: shareRow.bookingId },
          });
          if (shares.every((s) => s.status === 'paid')) {
            await tx.booking.update({
              where: { id: shareRow.bookingId },
              data: { paymentStatus: 'paid' },
            });
          }
        }
        return updated;
      });
    } catch (error) {
      if (charge.status === 'paid') {
        await this.paymentProvider.refund(
          shareRow.amount,
          shareRow.currency,
          charge.providerRef,
        );
      }
      throw error;
    }
  }

  // ---------- Check-in / completion ----------

  async checkIn(staffUser: AuthenticatedUser, qrPayload: string) {
    const { valid, bookingId } = verifyQrPayload(
      qrPayload,
      this.config.get<string>('QR_SIGNING_SECRET')!,
    );
    if (!valid || !bookingId) throw new BadRequestException('Invalid QR code');

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    await assertVenueStaffAccess(this.prisma, booking.venueId, staffUser);
    if (booking.status !== 'confirmed')
      throw new BadRequestException('Booking is not confirmed');
    if (booking.checkedInAt) throw new ConflictException('Already checked in');

    const [updated] = await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: bookingId },
        data: {
          checkedInAt: new Date(),
          checkedInByUserId: staffUser.id,
          status: 'completed',
        },
      }),
    ]);

    await this.awardCompletionCoins(booking);
    await this.prisma.user.update({
      where: { id: booking.userId },
      data: { matchesPlayed: { increment: 1 } },
    });
    return updated;
  }

  async checkInById(staffUser: AuthenticatedUser, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    await assertVenueStaffAccess(this.prisma, booking.venueId, staffUser);
    if (booking.qrPayload) return this.checkIn(staffUser, booking.qrPayload);
    if (booking.status !== 'confirmed') {
      throw new BadRequestException('Booking is not confirmed');
    }
    if (booking.checkedInAt) throw new ConflictException('Already checked in');
    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        checkedInAt: new Date(),
        checkedInByUserId: staffUser.id,
        status: 'completed',
      },
    });
    await this.awardCompletionCoins(booking);
    return updated;
  }

  async verifyVenueQr(
    staffUser: AuthenticatedUser,
    dto: { venueId: string; qrPayload?: string; code?: string },
  ) {
    await assertVenueStaffAccess(this.prisma, dto.venueId, staffUser);
    if (!dto.qrPayload && !dto.code) {
      return { outcome: 'invalid' as const, booking: null };
    }

    let bookingId: string | undefined;
    if (dto.qrPayload) {
      const signed = verifyQrPayload(
        dto.qrPayload,
        this.config.get<string>('QR_SIGNING_SECRET')!,
      );
      if (signed.valid) {
        bookingId = signed.bookingId;
      } else {
        try {
          const parsed = JSON.parse(dto.qrPayload) as {
            bookingId?: string;
            code?: string;
          };
          bookingId = parsed.bookingId;
          if (!bookingId && parsed.code) {
            const byCode = await this.prisma.booking.findUnique({
              where: { code: parsed.code },
            });
            bookingId = byCode?.id;
          }
        } catch {
          return { outcome: 'invalid' as const, booking: null };
        }
      }
    }

    const booking = bookingId
      ? await this.prisma.booking.findUnique({
          where: { id: bookingId },
          include: {
            court: true,
            user: { select: { id: true, name: true, phone: true } },
          },
        })
      : dto.code
        ? await this.prisma.booking.findUnique({
            where: { code: dto.code },
            include: {
              court: true,
              user: { select: { id: true, name: true, phone: true } },
            },
          })
        : null;

    if (!booking) return { outcome: 'not-found' as const, booking: null };
    if (booking.venueId !== dto.venueId) {
      return { outcome: 'wrong-venue' as const, booking: null };
    }
    if (booking.checkedInAt || booking.status === 'completed') {
      return { outcome: 'already-used' as const, booking };
    }
    if (booking.status !== 'confirmed') {
      return { outcome: 'not-confirmed' as const, booking };
    }
    return { outcome: 'ok' as const, booking };
  }

  async markNoShow(staffUser: AuthenticatedUser, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    await assertVenueStaffAccess(this.prisma, booking.venueId, staffUser);
    if (booking.status !== 'confirmed') {
      throw new BadRequestException(
        'Only confirmed bookings can be marked no-show',
      );
    }
    return this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'no_show' },
    });
  }

  async ownerCancel(
    staffUser: AuthenticatedUser,
    bookingId: string,
    reason?: string,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    await assertVenueStaffAccess(this.prisma, booking.venueId, staffUser);
    return this.settleCancellation(booking, reason ?? 'Cancelled by venue');
  }

  private async awardCompletionCoins(booking: Booking) {
    const setting = await this.prisma.platformSetting.findUnique({
      where: { id: 1 },
    });
    const venue = await this.prisma.venue.findUnique({
      where: { id: booking.venueId },
      include: { country: true },
    });
    const perHundred =
      venue?.country.coinsPerHundredMajor ?? setting?.coinsPerHundredEgp ?? 10;
    let coins = Math.round((booking.totalAmount / 100 / 100) * perHundred);

    const priorCompleted = await this.prisma.booking.count({
      where: {
        userId: booking.userId,
        status: 'completed',
        id: { not: booking.id },
      },
    });
    if (priorCompleted === 0) coins += FIRST_BOOKING_BONUS_COINS;

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: booking.userId },
        data: { coinsBalance: { increment: coins } },
      }),
      this.prisma.coinLedgerEntry.create({
        data: {
          userId: booking.userId,
          amount: coins,
          reason: 'booking_completed',
          bookingId: booking.id,
        },
      }),
    ]);
  }

  // ---------- Cancellation ----------

  refundPreviewPct(slotStart: Date): number {
    const hoursUntil = (slotStart.getTime() - Date.now()) / 3_600_000;
    if (hoursUntil >= 24) return 100;
    if (hoursUntil >= 2) return 50;
    return 0;
  }

  async cancel(userId: string, bookingId: string, reason?: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.userId !== userId)
      throw new ForbiddenException('Not your booking');
    return this.settleCancellation(booking, reason);
  }

  private async settleCancellation(
    booking: Booking,
    reason?: string,
  ): Promise<Booking> {
    if (!['held', 'confirmed'].includes(booking.status)) {
      throw new BadRequestException(
        'Booking cannot be cancelled in its current state',
      );
    }

    const refundPct =
      booking.status === 'held'
        ? 100
        : this.refundPreviewPct(booking.slotStart);
    const wasPaid =
      booking.paymentStatus === 'paid' || booking.paymentStatus === 'partial';
    let refundAmount = 0;
    let refundRef: string | undefined;
    if (wasPaid && refundPct > 0) {
      refundAmount = Math.round((booking.totalAmount * refundPct) / 100);
      const refund = await this.paymentProvider.refund(
        refundAmount,
        booking.currency,
      );
      refundRef = refund.providerRef;
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancellationReason: reason,
          paymentStatus: wasPaid ? 'refunded' : booking.paymentStatus,
        },
      });
      if (refundAmount > 0) {
        await tx.payment.create({
          data: {
            bookingId: booking.id,
            amount: -refundAmount,
            currency: booking.currency,
            method: booking.paymentMethod ?? 'card',
            status: 'refunded',
            providerRef: refundRef,
          },
        });
      }
      if (booking.status === 'confirmed' && booking.coinsRedeemed > 0) {
        await tx.user.update({
          where: { id: booking.userId },
          data: { coinsBalance: { increment: booking.coinsRedeemed } },
        });
        await tx.coinLedgerEntry.create({
          data: {
            userId: booking.userId,
            amount: booking.coinsRedeemed,
            reason: 'booking_cancel_restore',
            bookingId: booking.id,
          },
        });
      }
      return updated;
    });
  }

  // ---------- Reads ----------

  async getById(id: string, user: AuthenticatedUser) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: { court: true, venue: true, splitShares: true, promoCode: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.userId !== user.id) {
      await assertVenueStaffAccess(this.prisma, booking.venueId, user);
    }
    return booking;
  }

  listMine(userId: string, scope: 'upcoming' | 'past' | 'all' = 'all') {
    const now = new Date();
    const where: Prisma.BookingWhereInput = {
      userId,
      ...(scope === 'upcoming'
        ? { slotStart: { gte: now }, status: { in: ['held', 'confirmed'] } }
        : {}),
      ...(scope === 'past'
        ? {
            OR: [
              { slotStart: { lt: now } },
              { status: { in: ['completed', 'cancelled', 'no_show'] } },
            ],
          }
        : {}),
    };
    return this.prisma.booking.findMany({
      where,
      include: { court: true, venue: true },
      orderBy: { slotStart: scope === 'past' ? 'desc' : 'asc' },
      take: 100,
    });
  }

  async listAdmin(page = 1, perPage = 50) {
    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        include: {
          court: true,
          venue: true,
          user: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.booking.count(),
    ]);
    return {
      items,
      pagination: {
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage) || 1,
      },
    };
  }

  async listForVenue(
    venueId: string,
    user: AuthenticatedUser,
    status?: BookingStatus,
    q?: string,
  ) {
    await assertVenueStaffAccess(this.prisma, venueId, user);
    const query = q?.trim();
    return this.prisma.booking.findMany({
      where: {
        venueId,
        ...(status ? { status } : {}),
        ...(query
          ? {
              OR: [
                { code: { contains: query, mode: 'insensitive' } },
                { guestName: { contains: query, mode: 'insensitive' } },
                { guestPhone: { contains: query } },
                { user: { name: { contains: query, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: {
        court: true,
        user: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { slotStart: 'desc' },
      take: 200,
    });
  }

  // ---------- Recurring series ----------

  createRecurringSeries(userId: string, dto: CreateRecurringSeriesDto) {
    return this.prisma.recurringBookingSeries.create({
      data: { userId, ...dto },
    });
  }

  listMySeries(userId: string) {
    return this.prisma.recurringBookingSeries.findMany({
      where: { userId, active: true },
      include: { court: true },
    });
  }

  async confirmNextOccurrence(
    userId: string,
    seriesId: string,
    paymentMethod: ConfirmBookingDto['paymentMethod'],
  ) {
    const series = await this.prisma.recurringBookingSeries.findUnique({
      where: { id: seriesId },
    });
    if (!series || series.userId !== userId)
      throw new NotFoundException('Series not found');

    const next = this.nextOccurrence(series.dayOfWeek, series.startTime);
    const held = await this.holdSlot(userId, {
      courtId: series.courtId,
      slotStart: next.toISOString(),
    });
    const confirmed = await this.confirmBooking(userId, held.id, {
      paymentMethod,
    });
    return this.prisma.booking.update({
      where: { id: confirmed.id },
      data: { recurringSeriesId: seriesId },
    });
  }

  private nextOccurrence(dayOfWeek: number, startTime: string): Date {
    const [h, m] = startTime.split(':').map(Number);
    const date = new Date();
    date.setHours(h, m, 0, 0);
    let daysAhead = (dayOfWeek - date.getDay() + 7) % 7;
    if (daysAhead === 0 && date < new Date()) daysAhead = 7;
    date.setDate(date.getDate() + daysAhead);
    return date;
  }
}
