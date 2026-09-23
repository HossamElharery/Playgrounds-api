import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Booking, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { matchPricingRule } from '../../common/utils/pricing-rule.util';
import {
  zonedWallTimeToUtc,
  zonedWeekday,
} from '../../common/utils/timezone.util';
import {
  isTimeWithinDayHours,
  WeeklyHours,
} from '../../common/utils/weekly-hours.util';
import { signQrPayload } from '../../common/utils/qr.util';
import { isBookingSlotConflict } from '../../common/utils/booking-slot-conflict.util';
import { assertVenueStaffAccess } from '../../common/access/venue-access';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { ConfigService } from '@nestjs/config';
import { WalletService } from '../payments/wallet.service';
import { CommissionService } from '../finance/commission.service';
import { LedgerService } from '../finance/ledger.service';
import {
  bookingSnapshotFields,
  computeBookingMoney,
} from '../../common/money/booking-money';
import {
  CreateBundleDto,
  PurchaseBundleDto,
  UpdateBundleDto,
} from './dto/bundle.dto';
import { randomUUID } from 'crypto';

/**
 * Multi-activity bundles (§3.7/§7.3): a venue-defined combo of 2-4 units
 * ("padel court + PS5 room after your match, 15% off"). Purchasing a bundle
 * creates N linked, already-confirmed Booking rows sharing `bundleId`,
 * atomically — no new booking primitive, no hold step (bundles are
 * instant-pay upsells, matching §3.7's "booking a bundle creates two linked
 * Booking records ... not a new booking type").
 */
@Injectable()
export class BundlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly wallet: WalletService,
    private readonly commission: CommissionService,
    private readonly ledger: LedgerService,
  ) {}

  listForVenue(venueId: string) {
    return this.prisma.bundle.findMany({
      where: { venueId, active: true },
      include: { items: { include: { court: { include: { sport: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const bundle = await this.prisma.bundle.findUnique({
      where: { id },
      include: { items: { include: { court: { include: { sport: true } } } } },
    });
    if (!bundle) throw new NotFoundException('Bundle not found');
    return bundle;
  }

  async create(venueId: string, user: AuthenticatedUser, dto: CreateBundleDto) {
    await assertVenueStaffAccess(this.prisma, venueId, user);
    const courts = await this.prisma.court.findMany({
      where: { id: { in: dto.items.map((i) => i.courtId) }, venueId },
    });
    if (courts.length !== dto.items.length) {
      throw new BadRequestException(
        'All bundle items must be courts belonging to this venue',
      );
    }
    return this.prisma.bundle.create({
      data: {
        venueId,
        nameEn: dto.nameEn,
        nameAr: dto.nameAr,
        discountPercent: dto.discountPercent,
        items: {
          create: dto.items.map((i) => ({
            courtId: i.courtId,
            durationUnits: i.durationUnits,
          })),
        },
      },
      include: { items: true },
    });
  }

  async update(id: string, user: AuthenticatedUser, dto: UpdateBundleDto) {
    const bundle = await this.get(id);
    await assertVenueStaffAccess(this.prisma, bundle.venueId, user);
    if (dto.items) {
      const courts = await this.prisma.court.findMany({
        where: {
          id: { in: dto.items.map((i) => i.courtId) },
          venueId: bundle.venueId,
        },
      });
      if (courts.length !== dto.items.length) {
        throw new BadRequestException(
          'All bundle items must be courts belonging to this venue',
        );
      }
    }
    return this.prisma.$transaction(async (tx) => {
      if (dto.items) {
        await tx.bundleItem.deleteMany({ where: { bundleId: id } });
        await tx.bundleItem.createMany({
          data: dto.items.map((i) => ({
            bundleId: id,
            courtId: i.courtId,
            durationUnits: i.durationUnits,
          })),
        });
      }
      return tx.bundle.update({
        where: { id },
        data: {
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          discountPercent: dto.discountPercent,
          active: dto.active,
        },
        include: { items: true },
      });
    });
  }

  async quote(dto: PurchaseBundleDto) {
    const priced = await this.price(dto);
    return {
      baseAmount: priced.combinedBase,
      feeAmount: priced.feeAmount,
      discountAmount: priced.discountAmount,
      totalAmount: priced.totalAmount,
      currency: priced.currency,
    };
  }

  async purchase(userId: string, dto: PurchaseBundleDto) {
    const priced = await this.price(dto);
    const { bundle, lines, feeAmount, discountAmount, totalAmount } = priced;
    const qrSecret = this.config.get<string>('QR_SIGNING_SECRET')!;
    const commissionBps = await this.commission.resolveBps(bundle.venueId);
    const payAtVenue = bundle.venue.paymentMode === 'at_venue';
    const combinedBase = priced.combinedBase;

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          if (!payAtVenue) {
            await this.wallet.debit(tx, {
              userId,
              amount: totalAmount,
              reason: 'bundle',
            });
          }
          const bookings: Booking[] = [];
          for (const p of lines) {
            const blocked = await tx.calendarBlock.findFirst({
              where: {
                venueId: bundle.venueId,
                OR: [{ courtId: p.item.courtId }, { courtId: null }],
                startsAt: { lt: p.slotEnd },
                endsAt: { gt: p.slotStart },
              },
            });
            if (blocked) throw new ConflictException('SLOT_BLOCKED');

            const overlap = await tx.booking.findFirst({
              where: {
                courtId: p.item.courtId,
                status: { in: ['held', 'confirmed'] },
                slotStart: { lt: p.slotEnd },
                slotEnd: { gt: p.slotStart },
              },
            });
            if (overlap) throw new ConflictException('SLOT_ALREADY_HELD');

            // Distribute the combined discount/fee proportionally across items.
            const share = p.baseAmount / combinedBase;
            const itemFee = Math.round(feeAmount * share);
            const itemDiscount = Math.round(discountAmount * share);
            const money = computeBookingMoney({
              base: p.baseAmount,
              fee: itemFee,
              discount: itemDiscount,
              ownerFundedDiscount: itemDiscount,
              commissionBps,
            });

            const created = await tx.booking.create({
              data: {
                code: `MAL-${randomUUID().slice(0, 8).toUpperCase()}`,
                courtId: p.item.courtId,
                venueId: bundle.venueId,
                userId,
                slotStart: p.slotStart,
                slotEnd: p.slotEnd,
                baseAmount: p.baseAmount,
                feeAmount: itemFee,
                discountAmount: itemDiscount,
                totalAmount: money.total,
                currency: p.currency,
                paymentMethod: payAtVenue ? 'cash' : 'wallet',
                paymentStatus: payAtVenue ? 'pending' : 'paid',
                status: 'confirmed',
                bundleId: bundle.id,
                ...bookingSnapshotFields(money, bundle.venue.paymentMode),
              },
            });
            const qrPayload = signQrPayload(created.id, qrSecret);
            const withQr = await tx.booking.update({
              where: { id: created.id },
              data: { qrPayload },
            });
            if (!payAtVenue) {
              await tx.payment.create({
                data: {
                  bookingId: created.id,
                  amount: money.total,
                  currency: p.currency,
                  method: 'wallet',
                  status: 'paid',
                  providerRef: 'wallet',
                },
              });
            }
            await this.ledger.syncBookingLedger(tx, created.id, 'payment_paid');
            bookings.push(withQr);
          }
          return bookings;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (isBookingSlotConflict(error))
        throw new ConflictException('SLOT_ALREADY_HELD');
      throw error;
    }
  }

  private unitsFor(
    dto: PurchaseBundleDto,
    courtId: string,
    fallback: number,
  ): number {
    const raw = dto.unitsByCourt?.[courtId] ?? dto.units ?? fallback;
    const units = Number(raw);
    if (!Number.isInteger(units) || units < 1 || units > 4) {
      throw new BadRequestException(`Invalid duration for court ${courtId}`);
    }
    return units;
  }

  private async price(dto: PurchaseBundleDto) {
    const bundle = await this.prisma.bundle.findUnique({
      where: { id: dto.bundleId },
      include: {
        venue: { include: { country: true } },
        items: { include: { court: { include: { pricingRules: true } } } },
      },
    });
    if (!bundle || !bundle.active)
      throw new NotFoundException('Bundle not found');

    const timeZone = bundle.venue.country.timezone;
    const weeklyHours = bundle.venue.weeklyHours as WeeklyHours | null;
    const platformSetting = await this.prisma.platformSetting.findUnique({
      where: { id: 1 },
    });
    const feePct =
      bundle.venue.country.serviceFeePct ?? platformSetting?.serviceFeePct ?? 5;

    const lines = bundle.items.map((item) => {
      const hhmm = dto.startTimes?.[item.courtId];
      if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) {
        throw new BadRequestException(
          `Missing start time for court ${item.courtId}`,
        );
      }
      const slotStart = zonedWallTimeToUtc(dto.date, hhmm, timeZone);
      if (slotStart < new Date())
        throw new BadRequestException('Cannot book a past slot');
      if (weeklyHours) {
        const day = zonedWeekday(slotStart, timeZone);
        const dayHours =
          weeklyHours[String(day)] ??
          weeklyHours[day as unknown as string];
        if (!isTimeWithinDayHours(hhmm, dayHours)) {
          throw new BadRequestException('SLOT_OUTSIDE_HOURS');
        }
      }
      const units = this.unitsFor(dto, item.courtId, item.durationUnits);
      const slotEnd = new Date(
        slotStart.getTime() + item.court.slotDurationMins * units * 60_000,
      );
      const rule = matchPricingRule(
        item.court.pricingRules,
        zonedWeekday(slotStart, timeZone),
        slotStart,
        timeZone,
      );
      if (!rule)
        throw new BadRequestException(
          'One of the bundle courts has no pricing configured',
        );
      const baseAmount = rule.priceAmount * units;
      return { item, slotStart, slotEnd, baseAmount, currency: rule.currency };
    });

    const combinedBase = lines.reduce((sum, p) => sum + p.baseAmount, 0);
    const discountAmount = Math.round(
      (combinedBase * bundle.discountPercent) / 100,
    );
    const feeAmount = Math.round(combinedBase * (feePct / 100));
    const totalAmount = Math.max(0, combinedBase + feeAmount - discountAmount);
    return {
      bundle,
      lines,
      combinedBase,
      discountAmount,
      feeAmount,
      totalAmount,
      currency: lines[0]?.currency ?? bundle.venue.country.currency,
    };
  }
}
