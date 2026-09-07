import {
  BadRequestException,
  ConflictException,
  Inject,
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
import { signQrPayload } from '../../common/utils/qr.util';
import { isBookingSlotConflict } from '../../common/utils/booking-slot-conflict.util';
import { assertVenueStaffAccess } from '../../common/access/venue-access';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { ConfigService } from '@nestjs/config';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
} from '../payments/payment-provider.interface';
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
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
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

  async purchase(userId: string, dto: PurchaseBundleDto) {
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
    const platformSetting = await this.prisma.platformSetting.findUnique({
      where: { id: 1 },
    });
    const feePct =
      bundle.venue.country.serviceFeePct ?? platformSetting?.serviceFeePct ?? 5;

    const priced = bundle.items.map((item) => {
      const hhmm = dto.startTimes[item.courtId];
      if (!hhmm) {
        throw new BadRequestException(
          `Missing start time for court ${item.courtId}`,
        );
      }
      const slotStart = zonedWallTimeToUtc(dto.date, hhmm, timeZone);
      if (slotStart < new Date())
        throw new BadRequestException('Cannot book a past slot');
      const slotEnd = new Date(
        slotStart.getTime() +
          item.court.slotDurationMins * item.durationUnits * 60_000,
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
      const baseAmount = rule.priceAmount * item.durationUnits;
      return { item, slotStart, slotEnd, baseAmount, currency: rule.currency };
    });

    const combinedBase = priced.reduce((sum, p) => sum + p.baseAmount, 0);
    const discountAmount = Math.round(
      (combinedBase * bundle.discountPercent) / 100,
    );
    const feeAmount = Math.round(combinedBase * (feePct / 100));
    const totalAmount = Math.max(0, combinedBase + feeAmount - discountAmount);
    const currency = priced[0]?.currency ?? bundle.venue.country.currency;

    const allowed = bundle.venue.country.paymentMethods;
    if (!allowed.includes(dto.paymentMethod)) {
      throw new BadRequestException(
        `Payment method not available in ${bundle.venue.country.code}`,
      );
    }

    const charge = await this.paymentProvider.charge(
      totalAmount,
      currency,
      dto.paymentMethod,
    );
    if (charge.status === 'failed')
      throw new BadRequestException('PAYMENT_FAILED');
    const paymentStatus = charge.status === 'pending' ? 'pending' : 'paid';
    const qrSecret = this.config.get<string>('QR_SIGNING_SECRET')!;

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const bookings: Booking[] = [];
          for (const p of priced) {
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
            const itemTotal = Math.max(
              0,
              p.baseAmount + itemFee - itemDiscount,
            );

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
                totalAmount: itemTotal,
                currency: p.currency,
                paymentMethod: dto.paymentMethod,
                paymentStatus,
                status: 'confirmed',
                bundleId: bundle.id,
              },
            });
            const qrPayload = signQrPayload(created.id, qrSecret);
            const withQr = await tx.booking.update({
              where: { id: created.id },
              data: { qrPayload },
            });
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
}
