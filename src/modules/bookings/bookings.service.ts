import { usesMinuteTiming, assertActivityDuration } from '../../common/utils/activity-timing.util';
import { quoteDurationPrice } from '../../common/utils/price-quote.util';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { hasOpeningHours } from '../../common/utils/venue-readiness.util';
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
  zonedYmd,
  zonedWeekday,
} from '../../common/utils/timezone.util';
import {
  isTimeWithinDayHours,
  WeeklyHours,
} from '../../common/utils/weekly-hours.util';
import {
  isBookingSlotConflict,
  isUserBookingTimeConflict,
} from '../../common/utils/booking-slot-conflict.util';
import { coveringPricingRule, hasPricingCoverage } from '../../common/utils/pricing-rule.util';
import { moneyText } from '../../common/money/money-text';
import { assertVenueStaffAccess } from '../../common/access/venue-access';
import { assertBookingAccess, assertVenueAccess } from '../../common/access/owner-access';
import { netReceived } from '../owner/cash/payment-trail';
import { randomUUID } from 'crypto';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
} from '../payments/payment-provider.interface';
import { WalletService } from '../payments/wallet.service';
import { PaymentsConfigService } from '../payments/payments-config.service';
import { BookingNotifier } from './booking-notifier.service';
import { assertVenueBookable, computeVenueState, withoutInternalVenueFields } from '../../common/utils/venue-visibility.util';
import { RewardsService } from '../rewards/rewards.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CommissionService } from '../finance/commission.service';
import { LedgerService } from '../finance/ledger.service';
import { ApiException } from '../../common/errors/api-exception';
import {
  bookingSnapshotFields,
  computeBookingMoney,
} from '../../common/money/booking-money';

const HOLD_DURATION_MS = 2 * 60 * 1000; // 2 minutes, per §19.4's "60-120 seconds" guidance
const FIRST_BOOKING_BONUS_COINS = 200;
const FIRST_BOOKING_MIN_TOTAL = 5000;
const MAX_COIN_DISCOUNT_PCT = 30;
const MAX_ADVANCE_DAYS = 90;
// Player checkout is pay-at-venue unless the active payment provider reports
// itself live (PaymentsConfigService.isOnlinePaymentsLive). This is derived, not a
// hand-flipped constant: with no live provider nothing online can be offered.

const ONLINE_ONLY_METHODS = new Set([
  'card',
  'wallet',
  'apple_pay',
  'google_pay',
  'paypal',
  'vodafone',
  'orange',
  'etisalat',
  'fawry',
  'instapay',
  'mada',
  'stc_pay',
  'benefit',
  'knet',
]);

export interface SlotCell {
  start: string;
  end: string;
  hhmm: string;
  priceAmount: number;
  currency: string;
  state: 'available' | 'booked' | 'held' | 'past' | 'blocked' | 'unpriced';
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
    private readonly rewards: RewardsService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
    private readonly commission: CommissionService,
    private readonly ledger: LedgerService,
    private readonly paymentsConfig: PaymentsConfigService,
    private readonly notifier: BookingNotifier,
  ) {}

  private readonly logger = new Logger(BookingsService.name);


  async getSlotGrid(courtId: string, dateStr: string): Promise<SlotCell[]> {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: {
        sport: true,
        pricingRules: true,
        venue: { include: { country: true } },
      },
    });
    if (!court) throw new NotFoundException('Court not found');
    if (court.gamingPublished === false || !computeVenueState(court.venue).bookable) return [];

    // No opening hours means "not set up yet", never "open all day".
    if (!hasOpeningHours(court.venue.weeklyHours)) return [];

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
    const shared = await this.prisma.resourceOccupancy.findMany({where:{OR:[{resourceId:courtId},{resource:{gamingRoom:{bookableCourtId:courtId,occupancy:'exclusive'}}}],startsAt:{lt:dayEnd},AND:[{OR:[{endsAt:null},{endsAt:{gt:dayStart}}]}]}});
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
      const rule = coveringPricingRule(
        court.pricingRules,
        dayOfWeek,
        start,
        timeZone,
      );
      const overlapping = existing.find(
        (b) => b.slotStart < end && b.slotEnd > start,
      );
      const blocked = blocks.some((b) => b.startsAt < end && b.endsAt > start);

      let state: SlotCell['state'] = 'available';
      if (start < now) state = 'past';
      else if (blocked) state = 'blocked';
      else if (shared.some(r=>r.startsAt<end&&(!r.endsAt||r.endsAt>start||(r.running&&r.endsAt<=now)))) state = overlapping?.status==='held'?'held':'booked';
      else if (overlapping?.status === 'confirmed') state = 'booked';
      else if (overlapping?.status === 'held') state = 'held';
      else if (!rule || !hasPricingCoverage(court.pricingRules, start, end, timeZone)) state = 'unpriced';

      cells.push({
        start: start.toISOString(),
        end: end.toISOString(),
        hhmm: zonedHhmm(start, timeZone),
        priceAmount: rule?.priceAmount ?? 0,
        currency: court.venue.currency,
        state,
      });
    }
    return cells;
  }


  async holdSlot(userId: string, dto: HoldSlotDto): Promise<Booking> {
    const court = await this.prisma.court.findUnique({
      where: { id: dto.courtId },
      include: { sport: true, pricingRules: true, venue: { include: { country: true } } },
    });
    if (!court) throw new NotFoundException('Court not found');
    // Approved, listed by the owner, not hidden by the platform and accepting bookings.
    assertVenueBookable(court.venue);
    if (court.gamingPublished === false) {
      throw new ConflictException({
        code: 'VENUE_BOOKING_DISABLED',
        message: 'This venue is not accepting online bookings right now',
      });
    }
    if (!hasOpeningHours(court.venue.weeklyHours)) {
      throw new ConflictException({
        code: 'VENUE_NOT_READY',
        message: 'This venue has not set its opening hours yet',
      });
    }

    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (!account) throw new NotFoundException('User not found');
    if (account.status !== 'active') {
      throw new ForbiddenException({
        code: 'ACCOUNT_RESTRICTED',
        message: 'Your account cannot make bookings right now',
      });
    }

    const slotStart = new Date(dto.slotStart);
    const now = new Date();
    if (slotStart <= now)
      throw new BadRequestException({
        code: 'SLOT_IN_PAST',
        message: 'Cannot book a past slot',
      });

    if (slotStart.getTime() > now.getTime() + MAX_ADVANCE_DAYS * 86_400_000) {
      throw new BadRequestException({
        code: 'BOOKING_TOO_FAR_AHEAD',
        message: `Bookings can be made up to ${MAX_ADVANCE_DAYS} days ahead`,
      });
    }

    const timeZone = court.venue.country.timezone;
    const dayStart = zonedDayBounds(zonedYmd(slotStart, timeZone), timeZone).start;
    const stepMs = court.slotDurationMins * 60_000;
    if (
      !Number.isSafeInteger(court.slotDurationMins) ||
      court.slotDurationMins < 1 ||
      (slotStart.getTime() - dayStart.getTime()) % stepMs !== 0
    ) {
      throw new BadRequestException({
        code: 'INVALID_SLOT_START',
        message: 'The selected time must match an available slot',
      });
    }
    const rule = coveringPricingRule(
      court.pricingRules,
      zonedWeekday(slotStart, timeZone),
      slotStart,
      timeZone,
    );
    if (!rule)
      throw new BadRequestException('This court has no pricing configured');
    const units = dto.units ?? 1;
    const minuteTiming = usesMinuteTiming(court.sport?.activityKind);
    if(dto.durationMinutes !== undefined && !minuteTiming) throw new BadRequestException('INVALID_DURATION');
    const duration = dto.durationMinutes ?? court.slotDurationMins * units;
    assertActivityDuration(duration,court.sport?.activityKind);
    const slotEnd = new Date(
      slotStart.getTime() + duration * 60_000,
    );

    if (!hasPricingCoverage(court.pricingRules, slotStart, slotEnd, timeZone)) {
      throw new BadRequestException('This court has no pricing configured for the entire booking');
    }
    const weeklyHours = court.venue.weeklyHours as WeeklyHours | null;
    if (weeklyHours) {
      for (let at = slotStart.getTime(); at < slotEnd.getTime(); at += 15 * 60_000) {
        const instant = new Date(at);
        const dayHours = weeklyHours[String(zonedWeekday(instant, timeZone))];
        if (!isTimeWithinDayHours(zonedHhmm(instant, timeZone), dayHours)) {
          throw new BadRequestException('SLOT_OUTSIDE_HOURS');
        }
      }
    }

    const platformSetting = await this.prisma.platformSetting.findUnique({
      where: { id: 1 },
    });
    const feePct =
      court.venue.country.serviceFeePct ?? platformSetting?.serviceFeePct ?? 5;
    const baseAmount = minuteTiming ? quoteDurationPrice(court.pricingRules,slotStart,duration,timeZone,true).priceAmount! : rule.priceAmount * units;
    const feeAmount = Math.round(baseAmount * (feePct / 100));

    let discountAmount = 0;
    let promoCodeId: string | undefined;
    let ownerFundedDiscount = 0;
    if (dto.promoCode) {
      const promo = await this.validatePromo(dto.promoCode, userId, baseAmount, {
        venueId: court.venueId,
        sportId: court.sportId,
        currency: court.venue.currency,
      });
      if (dto.coinsToRedeem && !promo.stackableWithCoins) {
        throw new BadRequestException({
          code: 'PROMO_NOT_STACKABLE_WITH_COINS',
          message: 'This promo code cannot be combined with coins',
        });
      }
      discountAmount = promo.discountAmount;
      promoCodeId = promo.id;
      if (promo.venueId) ownerFundedDiscount = promo.discountAmount;
    }

    let coinsRedeemed = 0;
    if (dto.coinsToRedeem && dto.coinsToRedeem > 0) {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      const coinRate =
        court.venue.country.coinToMajorRate ??
        platformSetting?.coinToEgpRate ??
        20;
      const maxCoinDiscount = Math.max(
        0,
        Math.min(
          Math.floor((baseAmount * MAX_COIN_DISCOUNT_PCT) / 100),
          baseAmount - discountAmount,
        ),
      );
      const maxCoins = Math.floor((maxCoinDiscount / 100) * coinRate);
      coinsRedeemed = Math.max(
        0,
        Math.min(dto.coinsToRedeem, user.coinsBalance, maxCoins),
      );
      discountAmount += Math.min(
        maxCoinDiscount,
        Math.round((coinsRedeemed / coinRate) * 100),
      );
    }

    const totalAmount = Math.max(0, baseAmount + feeAmount - discountAmount);

    // A hold that has run out stops blocking the slot immediately, not on the
    // next 10-second sweep. Done in its own small transactions so it can never
    // make the booking transaction below fail with a serialization error.
    await this.releaseExpiredHolds({
      OR: [
        { courtId: court.id, slotStart: { lt: slotEnd }, slotEnd: { gt: slotStart } },
        { userId, slotStart: { lt: slotEnd }, slotEnd: { gt: slotStart } },
      ],
    });

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Double-click / network retry: the same player asking for the same slot
          // again gets their live hold back instead of a confusing conflict.
          const sameHold = await tx.booking.findFirst({
            where: {
              userId,
              courtId: court.id,
              slotStart,
              slotEnd,
              status: 'held',
              holdExpiresAt: { gt: new Date() },
            },
          });
          if (sameHold) return sameHold;

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

          const userOverlap = await tx.booking.findFirst({
            where: {
              userId,
              status: { in: ['held', 'confirmed'] },
              slotStart: { lt: slotEnd },
              slotEnd: { gt: slotStart },
            },
          });
          if (userOverlap) {
            throw new ConflictException({
              code: 'USER_TIME_CONFLICT',
              message: 'You already have another booking at this time',
            });
          }

          const occupiedResource = await tx.resourceOccupancy.findFirst({
            where: {
              OR: [
                { resourceId: court.id },
                {
                  resource: {
                    gamingRoom: {
                      bookableCourtId: court.id,
                      occupancy: 'exclusive',
                    },
                  },
                },
              ],
              startsAt: { lt: slotEnd },
              AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: slotStart } }] }],
            },
          });
          if (occupiedResource) throw new ConflictException('SLOT_ALREADY_HELD');

          if (coinsRedeemed > 0) {
            const spent = await tx.user.updateMany({
              where: { id: userId, coinsBalance: { gte: coinsRedeemed } },
              data: { coinsBalance: { decrement: coinsRedeemed } },
            });
            if (spent.count !== 1) {
              throw new BadRequestException('INSUFFICIENT_COINS');
            }
          }

          const commissionBps = await this.commission.resolveBps(
            court.venueId,
            tx,
          );
          const money = computeBookingMoney({
            base: baseAmount,
            fee: feeAmount,
            discount: discountAmount,
            ownerFundedDiscount,
            commissionBps,
          });
          if (money.total !== totalAmount) {
            throw new BadRequestException('MONEY_TOTAL_MISMATCH');
          }

          const created = await tx.booking.create({
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
              currency: court.venue.currency,
              promoCodeId,
              coinsRedeemed,
              status: 'held',
              holdExpiresAt: new Date(Date.now() + HOLD_DURATION_MS),
              ...bookingSnapshotFields(
                money,
                this.paymentsConfig.isOnlinePaymentsLive()
                  ? court.venue.paymentMode
                  : 'at_venue',
              ),
            },
          });

          if (coinsRedeemed > 0) {
            await tx.coinLedgerEntry.create({
              data: {
                userId,
                amount: -coinsRedeemed,
                reason: 'booking_redemption',
                bookingId: created.id,
              },
            });
          }

          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      // Two identical requests from one player (double-click, flaky-network retry) race
      // each other: one wins, the other must receive that same hold, not a conflict.
      if (
        error instanceof ConflictException ||
        isUserBookingTimeConflict(error) ||
        isBookingSlotConflict(error)
      ) {
        const mine = await this.prisma.booking.findFirst({
          where: {
            userId,
            courtId: court.id,
            slotStart,
            slotEnd,
            status: 'held',
            holdExpiresAt: { gt: new Date() },
          },
        });
        if (mine) return mine;
      }
      if (error instanceof ConflictException) throw error;
      if (isUserBookingTimeConflict(error)) {
        throw new ConflictException({
          code: 'USER_TIME_CONFLICT',
          message: 'You already have another booking at this time',
        });
      }
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
    context?: { venueId: string; sportId: string; currency: string },
  ) {
    const promo = await this.prisma.promoCode.findFirst({
      where: { code: { equals: code.trim(), mode: 'insensitive' } },
    });
    if (!promo || !promo.active)
      throw new BadRequestException('Invalid promo code');
    const now = new Date();
    if (now < promo.validFrom || now > promo.validUntil)
      throw new BadRequestException('Promo code expired');
    if (context) {
      if (promo.venueId && promo.venueId !== context.venueId) {
        throw new BadRequestException('Promo code is not valid for this venue');
      }
      if (promo.sportId && promo.sportId !== context.sportId) {
        throw new BadRequestException('Promo code is not valid for this activity');
      }
      if (promo.type !== 'percentage' && promo.currency !== context.currency) {
        throw new BadRequestException('Promo code currency does not match this venue');
      }
    }
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
      venueId: promo.venueId,
      stackableWithCoins: promo.stackableWithCoins,
    };
  }

  async previewPromo(code: string, userId: string, amount: number) {
    return this.validatePromo(code, userId, amount);
  }

  private holdExpired() {
    return new ApiException(
      HttpStatus.CONFLICT,
      'HOLD_EXPIRED',
      'This hold has expired. Pick a slot again.',
    );
  }

  /** Cancels a still-held booking and gives the coins back. Safe to repeat. */
  private async releaseHold(booking: { id: string; userId: string; coinsRedeemed: number }) {
    await this.prisma.$transaction(async (tx) => {
      const released = await tx.booking.updateMany({
        where: { id: booking.id, status: 'held' },
        data: { status: 'cancelled', holdExpiresAt: null },
      });
      if (released.count !== 1) return;
      if (booking.coinsRedeemed > 0) {
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
      await this.ledger.syncBookingLedger(tx, booking.id, 'cancelled');
    });
  }

  /** Frees holds whose window has run out so they stop blocking the slot. */
  private async releaseExpiredHolds(scope: Prisma.BookingWhereInput) {
    const expired = await this.prisma.booking.findMany({
      where: { status: 'held', holdExpiresAt: { lt: new Date() }, ...scope },
      select: { id: true, userId: true, coinsRedeemed: true },
      take: 20,
    });
    for (const hold of expired) await this.releaseHold(hold);
  }

  private generateBookingCode(): string {
    return `MAT-${randomUUID().slice(0, 8).toUpperCase()}`;
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
      await this.releaseHold(booking);
      throw this.holdExpired();
    }
    // The venue may have been hidden, suspended or paused since the hold was made.
    // Release the hold right away so the slot and the coins come back at once.
    try {
      assertVenueBookable(booking.venue);
    } catch (error) {
      await this.releaseHold(booking);
      throw error;
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
      const seen = new Set<string>();
      for (const share of shares) {
        if (!Number.isSafeInteger(share.amount) || share.amount <= 0) {
          throw new BadRequestException('SPLIT_AMOUNT_INVALID');
        }
        const key = share.userId ? `u:${share.userId}` : `p:${share.phone}`;
        if (seen.has(key)) throw new BadRequestException('SPLIT_DUPLICATE_PAYER');
        seen.add(key);
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

    const mode = this.paymentsConfig.isOnlinePaymentsLive()
      ? booking.paymentModeSnapshot ?? booking.venue.paymentMode ?? 'at_venue'
      : 'at_venue';
    if (mode === 'at_venue') {
      if (dto.paymentMethod && ONLINE_ONLY_METHODS.has(dto.paymentMethod)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'PAYMENT_MODE_AT_VENUE',
          'This venue collects payment at the venue',
        );
      }
      if (isSplit) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'PAYMENT_MODE_AT_VENUE',
          'Split payment is not available when paying at the venue',
        );
      }
    }

    const paymentStatus =
      mode === 'at_venue' ? 'pending' : isSplit ? 'partial' : 'paid';
    const paymentMethod =
      mode === 'at_venue' ? 'cash' : 'wallet';
    const qrPayload = signQrPayload(
      bookingId,
      this.config.get<string>('QR_SIGNING_SECRET')!,
    );

    const confirmedBooking = await this.prisma.$transaction(async (tx) => {
        if (mode === 'online') {
          await this.wallet.debit(tx, {
            userId,
            amount: chargeAmount,
            reason: 'booking',
            bookingId,
          });
        }

        const venueNow = await tx.venue.findUnique({ where: { id: booking.venueId } });
        if (!venueNow) throw new NotFoundException('Venue not found');
        assertVenueBookable(venueNow);

        const confirmed = await tx.booking.updateMany({
          // Still held AND still inside the hold window: an expiry that lands between
          // the read above and this write cannot be confirmed.
          where: { id: bookingId, status: 'held', holdExpiresAt: { gt: new Date() } },
          data: {
            status: 'confirmed',
            holdExpiresAt: null,
            paymentMethod,
            paymentStatus,
            isSplitPayment: isSplit,
            qrPayload,
          },
        });
        if (confirmed.count !== 1) {
          throw this.holdExpired();
        }

        if (mode === 'online') {
          await tx.payment.create({
            data: {
              bookingId,
              amount: chargeAmount,
              currency: booking.currency,
              method: 'wallet',
              status: 'paid',
              providerRef: 'wallet',
            },
          });
        }
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
              status: s.userId === userId ? 'paid' : 'pending',
            })),
          });
        }
        await this.ledger.syncBookingLedger(tx, bookingId, 'payment_paid');
        return tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
    });
    await this.notifications
      .create({
        dedupKey: `booking-confirmed-player:${bookingId}:${userId}`,
        userId,
        category: 'bookings',
        titleEn: `Booking confirmed — ${booking.venue.nameEn}`,
        titleAr: `تم تأكيد الحجز — ${booking.venue.nameAr}`,
        bodyEn: `Code ${confirmedBooking.code}`,
        bodyAr: `كود ${confirmedBooking.code}`,
        deepLink: '/app/bookings',
        payload: { kind: 'booking_confirmed', bookingId, venueId: booking.venueId, code: confirmedBooking.code },
      })
      .catch((error: unknown) =>
        this.logger.warn(`Player booking notice failed for ${bookingId}: ${String(error)}`),
      );
    // The venue side hears about it too: owner plus staff who can see this venue.
    // Retried and monitored inside the notifier; never fails the booking.
    await this.notifier.notifyVenueSide(bookingId, 'booking_confirmed');
    return confirmedBooking;
  }


  async paySplitShare(shareLinkToken: string, payerUserId?: string) {
    if (!payerUserId) throw new BadRequestException('LOGIN_REQUIRED');
    const share = await this.prisma.bookingSplitShare.findUnique({
      where: { shareLinkToken },
      include: { booking: { select: { currency: true, paymentMethod: true } } },
    });
    if (!share) throw new NotFoundException('Share link not found');
    const { booking, ...shareRow } = share;
    if (shareRow.status === 'paid') return shareRow;

    return this.prisma.$transaction(async (tx) => {
      await this.wallet.debit(tx, {
        userId: payerUserId,
        amount: shareRow.amount,
        reason: 'booking',
        bookingId: shareRow.bookingId,
      });
      const updated = await tx.bookingSplitShare.update({
        where: { id: shareRow.id },
        data: {
          status: 'paid',
          userId: shareRow.userId ?? payerUserId,
        },
      });
      await tx.payment.create({
        data: {
          bookingId: shareRow.bookingId,
          amount: shareRow.amount,
          currency: shareRow.currency,
          method: 'wallet',
          status: 'paid',
          providerRef: 'wallet',
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
        await this.ledger.syncBookingLedger(tx, shareRow.bookingId, 'payment_paid');
      }
      return updated;
    });
  }


  async checkIn(staffUser: AuthenticatedUser, qrPayload: string, method?: string) {
    const { valid, bookingId } = verifyQrPayload(
      qrPayload,
      this.config.get<string>('QR_SIGNING_SECRET')!,
    );
    if (!valid || !bookingId) throw new BadRequestException('Invalid QR code');

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    await assertBookingAccess(this.prisma, staffUser, booking.id, { write: true });
    if (booking.status !== 'confirmed')
      throw new BadRequestException('Booking is not confirmed');
    if (booking.checkedInAt) throw new ConflictException('Already checked in');

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.booking.update({
        where: { id: bookingId },
        data: {
          checkedInAt: new Date(),
          checkedInByUserId: staffUser.id,
          status: 'completed',
        },
      });
      await this.recordAtVenueCollection(tx, booking, staffUser.id, method);
      await this.ledger.syncBookingLedger(tx, bookingId, 'checked_in');
      return row;
    });

    const { isFirstBooking } = await this.awardCompletionCoins(booking);
    await this.prisma.user.update({
      where: { id: booking.userId },
      data: { matchesPlayed: { increment: 1 } },
    });
    await this.rewards.onBookingCompleted({
      bookingId: booking.id,
      userId: booking.userId,
      courtId: booking.courtId,
      isFirstBooking,
    });
    return updated;
  }

  private async recordAtVenueCollection(
    tx: Prisma.TransactionClient,
    booking: { id: string; source: string; paymentModeSnapshot: string | null; totalAmount: number; currency: string },
    staffUserId: string,
    method?: string,
  ) {
    if (booking.source !== 'platform' || booking.paymentModeSnapshot === 'online') return;
    const { received } = await netReceived(tx, booking.id);
    const due = booking.totalAmount - received;
    if (due <= 0) return;
    const m = method === 'instapay' || method === 'wallet' || method === 'card' || method === 'fawry' ? method : method === 'other' ? 'wallet' : 'cash';
    await tx.payment.create({
      data: {
        bookingId: booking.id,
        amount: due,
        currency: booking.currency,
        method: m,
        status: 'paid',
        recordedByUserId: staffUserId,
        note: 'at_venue_check_in',
      },
    });
  }

  async checkInById(staffUser: AuthenticatedUser, bookingId: string, method?: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    await assertBookingAccess(this.prisma, staffUser, bookingId, { write: true });
    if (booking.qrPayload) return this.checkIn(staffUser, booking.qrPayload, method);
    if (booking.status !== 'confirmed') {
      throw new BadRequestException('Booking is not confirmed');
    }
    if (booking.checkedInAt) throw new ConflictException('Already checked in');
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.booking.update({
        where: { id: bookingId },
        data: {
          checkedInAt: new Date(),
          checkedInByUserId: staffUser.id,
          status: 'completed',
        },
      });
      await this.recordAtVenueCollection(tx, booking, staffUser.id, method);
      await this.ledger.syncBookingLedger(tx, bookingId, 'checked_in');
      return row;
    });
    const { isFirstBooking } = await this.awardCompletionCoins(booking);
    await this.prisma.user.update({
      where: { id: booking.userId },
      data: { matchesPlayed: { increment: 1 } },
    });
    await this.rewards.onBookingCompleted({
      bookingId: booking.id,
      userId: booking.userId,
      courtId: booking.courtId,
      isFirstBooking,
    });
    return updated;
  }

  async verifyVenueQr(
    staffUser: AuthenticatedUser,
    dto: { venueId: string; qrPayload?: string; code?: string },
  ) {
    await assertVenueAccess(this.prisma, staffUser, dto.venueId, { write: false });
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
    await assertBookingAccess(this.prisma, staffUser, bookingId, { write: true });
    if (booking.status !== 'confirmed') {
      throw new BadRequestException(
        'Only confirmed bookings can be marked no-show',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: { status: 'no_show' },
      });
      await this.ledger.syncBookingLedger(tx, bookingId, 'no_show');
      return updated;
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
    await assertBookingAccess(this.prisma, staffUser, bookingId, { write: true });
    if (booking.source === 'platform') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'PLATFORM_BOOKING_LOCKED',
        'Matchena bookings can only be cancelled by an admin. Send a change request instead.',
      );
    }
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'USE_DELETE',
      'Manual bookings are removed with DELETE /owner/bookings/:id',
    );
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
    const isFirstBooking = priorCompleted === 0;
    if (isFirstBooking && booking.totalAmount >= FIRST_BOOKING_MIN_TOTAL) {
      coins += FIRST_BOOKING_BONUS_COINS;
    }

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

    return { isFirstBooking };
  }


  refundPreviewPct(slotStart: Date): number {
    const hoursUntil = (slotStart.getTime() - Date.now()) / 3_600_000;
    if (hoursUntil >= 24) return 100;
    if (hoursUntil >= 2) return 50;
    return 0;
  }

  async refundPreview(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.userId !== userId)
      throw new ForbiddenException('Not your booking');
    const refundPct =
      booking.status === 'held' ? 100 : this.refundPreviewPct(booking.slotStart);
    const wasPaid =
      booking.paymentStatus === 'paid' || booking.paymentStatus === 'partial';
    return {
      refundPct,
      refundAmount: wasPaid
        ? Math.round((booking.totalAmount * refundPct) / 100)
        : 0,
      currency: booking.currency,
      coinsRestored:
        ['held', 'confirmed'].includes(booking.status)
          ? booking.coinsRedeemed
          : 0,
    };
  }

  async cancelByAdmin(actorId: string, bookingId: string, reason: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    return this.settleCancellation(booking, reason, actorId);
  }

  async cancel(userId: string, bookingId: string, reason?: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.userId !== userId)
      throw new ForbiddenException('Not your booking');
    return this.settleCancellation(booking, reason, undefined, true);
  }

  private async settleCancellation(
    booking: Booking,
    reason?: string,
    adminActorId?: string,
    cancelledByPlayer = false,
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
    const refundToWallet = booking.paymentMethod === 'wallet';
    if (wasPaid && refundPct > 0) {
      refundAmount = Math.round((booking.totalAmount * refundPct) / 100);
    }

    const settled = await this.prisma.$transaction(async (tx) => {
      const cancelled = await tx.booking.updateMany({
        where: { id: booking.id, status: booking.status },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancellationReason: reason,
          paymentStatus: wasPaid ? 'refunded' : booking.paymentStatus,
        },
      });
      if (cancelled.count !== 1) {
        throw new ConflictException('Booking was already resolved');
      }
      if (refundAmount > 0) {
        if (!refundToWallet) {
          // Only after this request has won the cancellation: a concurrent cancel
          // that lost the race above never reaches the provider, so a refund is
          // issued at most once per booking. A provider failure rolls everything back.
          const refund = await this.paymentProvider.refund(refundAmount, booking.currency);
          refundRef = refund.providerRef;
        }
        if (refundToWallet) {
          await this.wallet.credit(tx, {
            userId: booking.userId,
            amount: refundAmount,
            reason: 'refund',
            method: 'wallet',
            bookingId: booking.id,
            providerRef: 'wallet',
          });
        }
        await tx.payment.create({
          data: {
            bookingId: booking.id,
            amount: -refundAmount,
            currency: booking.currency,
            method: booking.paymentMethod ?? 'wallet',
            status: 'refunded',
            providerRef: refundRef ?? 'wallet',
          },
        });
      }
      if (booking.coinsRedeemed > 0) {
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
      if (adminActorId) await tx.auditLogEntry.create({ data: {
        actorUserId: adminActorId, action: 'admin.booking.cancel', targetType: 'booking', targetId: booking.id,
        metadata: { venueId: booking.venueId, reason: reason ?? '', previousStatus: booking.status, refundAmount },
      } });
      await this.ledger.syncBookingLedger(
        tx,
        booking.id,
        adminActorId ? 'admin_cancel' : 'cancelled',
      );
      return tx.booking.findUniqueOrThrow({ where: { id: booking.id } });
    });

    await this.notifications
      .create({
        userId: booking.userId,
        category: 'bookings',
        titleEn: cancelledByPlayer
          ? 'Your booking was cancelled'
          : 'Your booking was cancelled by the venue',
        titleAr: cancelledByPlayer
          ? 'تم إلغاء حجزك'
          : 'الملعب ألغى حجزك',
        bodyEn: refundAmount > 0 ? `${moneyText(refundAmount, booking.currency, 'en')} refunded to your wallet` : 'No refund was due under the cancellation policy',
        bodyAr: refundAmount > 0 ? `تم رد ${moneyText(refundAmount, booking.currency, 'ar')} إلى محفظتك` : 'لا يوجد مبلغ مسترد حسب سياسة الإلغاء',
        deepLink: '/app/bookings',
        payload: { kind: 'booking_cancelled', bookingId: booking.id, venueId: booking.venueId, refundAmount },
      })
      .catch((error: unknown) =>
        this.logger.warn(`Player cancel notice failed for ${booking.id}: ${String(error)}`),
      );
    if (booking.status === 'confirmed') await this.notifier.notifyVenueSide(booking.id, 'booking_cancelled');
    return settled;
  }


  async getById(id: string, user: AuthenticatedUser) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: { court: true, venue: true, splitShares: true, promoCode: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.userId !== user.id) {
      await assertVenueStaffAccess(this.prisma, booking.venueId, user);
      return booking;
    }
    // The player sees their booking and the venue's public details, not its moderation columns.
    return { ...booking, venue: withoutInternalVenueFields(booking.venue) };
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
      include: {
        court: true,
        venue: {
          select: {
            id: true,
            slug: true,
            nameAr: true,
            nameEn: true,
            photos: { orderBy: { position: 'asc' }, take: 1 },
          },
        },
        reviews: { where: { userId }, select: { id: true }, take: 1 },
      },
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
