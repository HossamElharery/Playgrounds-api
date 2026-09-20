import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommissionService, DbClient } from './commission.service';
import {
  BookingMoney,
  BookingStatusKind,
  PaymentStatusKind,
  VenuePaymentModeKind,
  computeBookingMoney,
  desiredLedgerDelta,
} from '../../common/money/booking-money';

const ACCRUAL_KINDS = ['booking_accrual', 'booking_adjustment'] as const;

export interface LedgerIntegrityIssue {
  bookingId?: string;
  kind: 'booking_mismatch' | 'missing_accrual' | 'balance_mismatch';
  expected: number;
  actual: number;
  currency: string;
}

@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commission: CommissionService,
  ) {}

  /**
   * Idempotent: computes the desired accrued delta from the booking's current
   * state and writes at most one new entry for the difference vs existing
   * accrual/adjustment rows. Caller MUST run this inside a transaction that
   * already mutated the booking (or pass `tx` wrapping a `SELECT … FOR UPDATE`).
   */
  async syncBookingLedger(
    tx: Prisma.TransactionClient,
    bookingId: string,
    reason?: string,
  ): Promise<{ wrote: boolean; delta: number; desired: number }> {
    await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${bookingId} FOR UPDATE`;
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) return { wrote: false, delta: 0, desired: 0 };

    const money = await this.moneyFor(tx, booking);
    const desired = desiredLedgerDelta({
      source: booking.source,
      paymentMode: (booking.paymentModeSnapshot ?? 'at_venue') as VenuePaymentModeKind,
      status: booking.status as BookingStatusKind,
      paymentStatus: booking.paymentStatus as PaymentStatusKind,
      checkedInAt: booking.checkedInAt,
      money,
    });

    const existing = await tx.venueLedgerEntry.aggregate({
      where: {
        bookingId,
        kind: { in: [...ACCRUAL_KINDS] },
      },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const current = existing._sum.amount ?? 0;
    const delta = desired - current;
    if (delta === 0) return { wrote: false, delta: 0, desired };

    const firstWrite = (existing._count._all ?? 0) === 0;
    await tx.venueLedgerEntry.create({
      data: {
        venueId: booking.venueId,
        currency: booking.currency,
        kind: firstWrite ? 'booking_accrual' : 'booking_adjustment',
        amount: delta,
        bookingId,
        reason: firstWrite ? (reason ?? 'accrual') : (reason ?? 'resync'),
      },
    });
    return { wrote: true, delta, desired };
  }

  async recordPayout(
    tx: Prisma.TransactionClient,
    opts: {
      venueId: string;
      currency: string;
      amount: number;
      settlementId: string;
      reason: string;
      createdById: string;
    },
  ) {
    return tx.venueLedgerEntry.create({
      data: {
        venueId: opts.venueId,
        currency: opts.currency,
        kind: 'payout_to_owner',
        amount: -Math.abs(opts.amount),
        settlementId: opts.settlementId,
        reason: opts.reason,
        createdById: opts.createdById,
      },
    });
  }

  async recordRemittance(
    tx: Prisma.TransactionClient,
    opts: {
      venueId: string;
      currency: string;
      amount: number;
      settlementId: string;
      reason: string;
      createdById: string;
    },
  ) {
    return tx.venueLedgerEntry.create({
      data: {
        venueId: opts.venueId,
        currency: opts.currency,
        kind: 'remittance_from_owner',
        amount: Math.abs(opts.amount),
        settlementId: opts.settlementId,
        reason: opts.reason,
        createdById: opts.createdById,
      },
    });
  }

  async getBalance(venueId: string, currency = 'EGP', tx?: DbClient) {
    const db = tx ?? this.prisma;
    const agg = await db.venueLedgerEntry.aggregate({
      where: { venueId, currency },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }

  async getBalances(venueIds: string[]) {
    if (!venueIds.length) return [];
    return this.prisma.venueLedgerEntry.groupBy({
      by: ['venueId', 'currency'],
      where: { venueId: { in: venueIds } },
      _sum: { amount: true },
    });
  }

  async listEntries(
    venueId: string,
    opts: {
      cursor?: string;
      limit?: number;
      kind?: string;
      from?: Date;
      to?: Date;
    } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const items = await this.prisma.venueLedgerEntry.findMany({
      where: {
        venueId,
        ...(opts.kind ? { kind: opts.kind as never } : {}),
        ...(opts.from || opts.to
          ? {
              createdAt: {
                ...(opts.from ? { gte: opts.from } : {}),
                ...(opts.to ? { lte: opts.to } : {}),
              },
            }
          : {}),
      },
      include: {
        booking: { select: { id: true, code: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1].id : undefined,
    };
  }

  async postManualAdjustment(
    venueId: string,
    amount: number,
    reason: string,
    adminId: string,
    currency = 'EGP',
  ) {
    return this.prisma.venueLedgerEntry.create({
      data: {
        venueId,
        currency,
        kind: 'manual_adjustment',
        amount,
        reason,
        createdById: adminId,
      },
    });
  }

  async verifyLedgerIntegrity(
    venueId: string,
  ): Promise<{ ok: boolean; balance: number; issues: LedgerIntegrityIssue[] }> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, paymentMode: true, priceFromCurrency: true },
    });
    const currency = venue?.priceFromCurrency ?? 'EGP';
    const issues: LedgerIntegrityIssue[] = [];
    const bookings = await this.prisma.booking.findMany({
      where: { venueId, source: 'platform' },
    });
    let expectedFromBookings = 0;
    for (const booking of bookings) {
      const money = await this.moneyFor(this.prisma, booking);
      const desired = desiredLedgerDelta({
        source: booking.source,
        paymentMode: (booking.paymentModeSnapshot ??
          venue?.paymentMode ??
          'at_venue') as VenuePaymentModeKind,
        status: booking.status as BookingStatusKind,
        paymentStatus: booking.paymentStatus as PaymentStatusKind,
        checkedInAt: booking.checkedInAt,
        money,
      });
      expectedFromBookings += desired;
      const actualAgg = await this.prisma.venueLedgerEntry.aggregate({
        where: { bookingId: booking.id, kind: { in: [...ACCRUAL_KINDS] } },
        _sum: { amount: true },
      });
      const actual = actualAgg._sum.amount ?? 0;
      if (actual !== desired) {
        issues.push({
          bookingId: booking.id,
          kind: desired !== 0 && actual === 0 ? 'missing_accrual' : 'booking_mismatch',
          expected: desired,
          actual,
          currency: booking.currency,
        });
      }
    }

    const settlementSum = await this.prisma.venueLedgerEntry.aggregate({
      where: {
        venueId,
        currency,
        kind: {
          in: ['payout_to_owner', 'remittance_from_owner', 'manual_adjustment'],
        },
      },
      _sum: { amount: true },
    });
    const expectedBalance =
      expectedFromBookings + (settlementSum._sum.amount ?? 0);
    const actualBalance = await this.getBalance(venueId, currency);
    if (actualBalance !== expectedBalance) {
      issues.push({
        kind: 'balance_mismatch',
        expected: expectedBalance,
        actual: actualBalance,
        currency,
      });
    }
    return { ok: issues.length === 0, balance: actualBalance, issues };
  }

  private async moneyFor(
    db: DbClient,
    booking: {
      venueId: string;
      baseAmount: number;
      feeAmount: number;
      discountAmount: number;
      ownerFundedDiscount: number;
      commissionBps: number | null;
      commissionAmount: number | null;
      ownerNetAmount: number | null;
    },
  ): Promise<BookingMoney> {
    const bps =
      booking.commissionBps ?? (await this.commission.resolveBps(booking.venueId, db));
    const computed = computeBookingMoney({
      base: booking.baseAmount,
      fee: booking.feeAmount,
      discount: booking.discountAmount,
      ownerFundedDiscount: booking.ownerFundedDiscount,
      commissionBps: bps,
    });
    if (
      booking.commissionBps == null ||
      booking.commissionAmount == null ||
      booking.ownerNetAmount == null
    ) {
      return computed;
    }
    return {
      ...computed,
      commissionBps: booking.commissionBps,
      commissionAmount: booking.commissionAmount,
      ownerNet: booking.ownerNetAmount,
      platformTake: computed.total - booking.ownerNetAmount,
    };
  }
}
