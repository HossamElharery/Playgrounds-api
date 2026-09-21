import { isSafeReceiptUrl } from '../../common/utils/receipt-url.util';
import {
  BadRequestException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { CommissionService } from '../finance/commission.service';
import { LedgerService } from '../finance/ledger.service';
import { PaymentsConfigService } from '../payments/payments-config.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../email/email.service';
import { OwnerSummaryService } from '../owner/owner-summary.service';
import { OwnerBookingsService } from '../owner/owner-bookings.service';
import { OwnerService } from '../owner/owner.service';
import { BookingsService } from '../bookings/bookings.service';
import { ApiException } from '../../common/errors/api-exception';
import { formatMoney, notifyFinance } from '../finance/finance-notify';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import type {
  AdminAdjustmentDto,
  AdminBalancesQueryDto,
  AdminCommissionDto,
  AdminGlobalCommissionDto,
  AdminPaymentModeDto,
  AdminPayoutDto,
} from './dto/admin-finance.dto';

function directionOf(balance: number): 'matchena_owes' | 'owner_owes' | 'settled' {
  if (balance > 0) return 'matchena_owes';
  if (balance < 0) return 'owner_owes';
  return 'settled';
}

@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commission: CommissionService,
    private readonly ledger: LedgerService,
    private readonly payments: PaymentsConfigService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly summary: OwnerSummaryService,
    private readonly ownerBookings: OwnerBookingsService,
    private readonly owner: OwnerService,
    private readonly bookings: BookingsService,
    private readonly config: ConfigService,
  ) {}

  private adminUser(user: AuthenticatedUser): AuthenticatedUser {
    return { ...user, roles: ['admin'] };
  }

  async financeSettings(venueId: string) {
    const venue = await this.requireVenue(venueId);
    const resolved = await this.commission.resolveSource(venueId);
    const globalBps = await this.commission.globalBps();
    const history = await this.prisma.auditLogEntry.findMany({
      where: {
        targetId: venueId,
        action: { in: ['venue.commission.updated', 'venue.payment_mode.updated'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return {
      venueId,
      commissionBps: resolved.bps,
      commissionSource: resolved.source,
      globalBps,
      paymentMode: venue.paymentMode,
      onlinePaymentsLive: this.payments.isOnlinePaymentsLive(),
      paymentModeChangedAt: venue.paymentModeChangedAt,
      history,
    };
  }

  async patchCommission(admin: AuthenticatedUser, venueId: string, dto: AdminCommissionDto) {
    const venue = await this.requireVenue(venueId);
    const result = await this.commission.setVenueBps(
      venueId,
      dto.percentageBps === undefined ? null : dto.percentageBps,
      admin.id,
      dto.reason,
    );
    await this.commission.notifyOwnerCommissionChanged(venue.ownerId, venueId, result.effective);
    return {
      ...result,
      message: 'applies to new bookings only',
    };
  }

  async patchPaymentMode(admin: AuthenticatedUser, venueId: string, dto: AdminPaymentModeDto) {
    const venue = await this.requireVenue(venueId);
    if (dto.paymentMode === 'online' && !this.payments.isOnlinePaymentsLive()) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'ONLINE_PAYMENTS_NOT_LIVE',
        'Online payments are not live yet',
      );
    }
    const previous = venue.paymentMode;
    const futureUnderOld = await this.prisma.booking.count({
      where: {
        venueId,
        slotStart: { gt: new Date() },
        status: { in: ['held', 'confirmed'] },
        OR: [{ paymentModeSnapshot: previous }, { paymentModeSnapshot: null }],
      },
    });
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.venue.update({
        where: { id: venueId },
        data: { paymentMode: dto.paymentMode, paymentModeChangedAt: new Date() },
      });
      await tx.auditLogEntry.create({
        data: {
          actorUserId: admin.id,
          action: 'venue.payment_mode.updated',
          targetType: 'venue',
          targetId: venueId,
          metadata: { from: previous, to: dto.paymentMode, reason: dto.reason },
        },
      });
      return row;
    });
    await notifyFinance(this.notifications, {
      userId: venue.ownerId,
      titleEn: `Pay-at-venue setting is now ${dto.paymentMode === 'online' ? 'online' : 'at the venue'}`,
      titleAr: dto.paymentMode === 'online' ? 'الدفع بقى أونلاين' : 'الدفع في الملعب',
      bodyEn: 'New Matchena bookings use the new mode. Existing bookings keep their original mode.',
      bodyAr: 'الحجوزات الجديدة تتبع الوضع الجديد. الحجوزات الحالية تفضل زي ما هي.',
      payload: { venueId, paymentMode: dto.paymentMode },
    });
    return {
      paymentMode: updated.paymentMode,
      paymentModeChangedAt: updated.paymentModeChangedAt,
      futureBookingsKeepingPreviousMode: futureUnderOld,
    };
  }

  async getGlobalCommission() {
    const bps = await this.commission.globalBps();
    const venuesWithoutOverride = await this.prisma.venue.count({
      where: { commissionSetting: null },
    });
    return { percentageBps: bps, venuesWithoutOverride };
  }

  async patchGlobalCommission(admin: AuthenticatedUser, dto: AdminGlobalCommissionDto) {
    return this.commission.setGlobalBps(dto.percentageBps, admin.id, dto.reason);
  }

  async balances(query: AdminBalancesQueryDto) {
    const venues = await this.prisma.venue.findMany({
      where: {
        ...(query.paymentMode ? { paymentMode: query.paymentMode } : {}),
        ...(query.q
          ? {
              OR: [
                { nameEn: { contains: query.q, mode: 'insensitive' } },
                { nameAr: { contains: query.q, mode: 'insensitive' } },
                { owner: { name: { contains: query.q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        nameEn: true,
        nameAr: true,
        paymentMode: true,
        priceFromCurrency: true,
        owner: { select: { id: true, name: true } },
      },
    });
    const ids = venues.map((v) => v.id);
    const [sums, pending, last, settings] = await Promise.all([
      ids.length
        ? this.prisma.venueLedgerEntry.groupBy({
            by: ['venueId', 'currency'],
            where: { venueId: { in: ids } },
            _sum: { amount: true },
          })
        : Promise.resolve(
            [] as { venueId: string; currency: string; _sum: { amount: number | null } }[],
          ),
      ids.length
        ? this.prisma.venueSettlement.groupBy({
            by: ['venueId'],
            where: { venueId: { in: ids }, status: 'pending_confirmation' },
            _count: { _all: true },
          })
        : Promise.resolve([] as { venueId: string; _count: { _all: number } }[]),
      ids.length
        ? this.prisma.venueSettlement.groupBy({
            by: ['venueId'],
            where: { venueId: { in: ids }, status: 'confirmed' },
            _max: { createdAt: true },
          })
        : Promise.resolve(
            [] as { venueId: string; _max: { createdAt: Date | null } }[],
          ),
      this.prisma.commissionSetting.findMany(),
    ]);
    const global = settings.find((s) => s.venueId == null)?.percentageBps ?? 1000;
    const override = new Map(
      settings.filter((s) => s.venueId).map((s) => [s.venueId as string, s.percentageBps]),
    );
    const balMap = new Map(sums.map((s) => [`${s.venueId}:${s.currency}`, s._sum.amount ?? 0]));
    const pendingMap = new Map(pending.map((p) => [p.venueId, p._count._all]));
    const lastMap = new Map(last.map((p) => [p.venueId, p._max.createdAt]));

    let rows = venues.map((v) => {
      const currency = v.priceFromCurrency ?? 'EGP';
      const balance = balMap.get(`${v.id}:${currency}`) ?? 0;
      return {
        venueId: v.id,
        venueName: v.nameEn,
        ownerName: v.owner.name,
        currency,
        balance,
        direction: directionOf(balance),
        commissionBps: override.get(v.id) ?? global,
        paymentMode: v.paymentMode,
        lastSettlementAt: lastMap.get(v.id) ?? null,
        pendingRemittances: pendingMap.get(v.id) ?? 0,
      };
    });
    if (query.direction) rows = rows.filter((r) => r.direction === query.direction);
    if (query.minAbsBalance) rows = rows.filter((r) => Math.abs(r.balance) >= query.minAbsBalance!);
    rows.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || a.venueId.localeCompare(b.venueId));
    const limit = Math.min(query.limit ?? 30, 100);
    let start = 0;
    if (query.cursor) {
      const idx = rows.findIndex((r) => r.venueId === query.cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const page = rows.slice(start, start + limit);
    const totals = {
      matchenaOwesOwners: rows.filter((r) => r.balance > 0).reduce((s, r) => s + r.balance, 0),
      ownersOweMatchena: rows.filter((r) => r.balance < 0).reduce((s, r) => s + -r.balance, 0),
      net: rows.reduce((s, r) => s + r.balance, 0),
    };
    return {
      items: page,
      nextCursor: start + page.length < rows.length ? page[page.length - 1]?.venueId : undefined,
      totals,
    };
  }

  /** Audit trail for one venue: its own settings/ledger events plus bookings and settlements that belong to it. */
  async venueAudit(venueId: string, cursor?: string, limit = 30) {
    await this.requireVenue(venueId);
    const take = Math.min(Math.max(limit, 1), 100);
    const items = await this.prisma.auditLogEntry.findMany({
      where: {
        OR: [
          { targetType: 'venue', targetId: venueId },
          { metadata: { path: ['venueId'], equals: venueId } },
        ],
      },
      include: { actor: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1].id : undefined };
  }

  async venueLedger(venueId: string, cursor?: string, limit = 30) {
    await this.requireVenue(venueId);
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    const currency = venue?.priceFromCurrency ?? 'EGP';
    const balance = await this.ledger.getBalance(venueId, currency);
    const page = await this.ledger.listEntries(venueId, { cursor, limit });
    // On later pages the first row is not the newest entry, so its running
    // balance is the current balance minus everything newer than that row.
    let running = balance;
    if (cursor && page.items.length) {
      const first = page.items[0];
      const newer = await this.prisma.venueLedgerEntry.aggregate({
        where: {
          venueId,
          currency,
          OR: [
            { createdAt: { gt: first.createdAt } },
            { createdAt: first.createdAt, id: { gt: first.id } },
          ],
        },
        _sum: { amount: true },
      });
      running = balance - (newer._sum.amount ?? 0);
    }
    const items = page.items.map((entry) => {
      const withRun = { ...entry, runningBalance: running };
      running -= entry.amount;
      return withRun;
    });
    return {
      venueId,
      currency,
      balance,
      runningBalanceMethod:
        'Page is newest-first. runningBalance of the first row equals the current venue balance; each next row subtracts the previous row amount.',
      items,
      nextCursor: page.nextCursor,
    };
  }

  async payout(admin: AuthenticatedUser, venueId: string, dto: AdminPayoutDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const cached = await this.prisma.idempotencyKey.findUnique({
        where: { key: `${admin.id}:${idempotencyKey}` },
      });
      if (cached) return cached.responseBody;
    }
    const venue = await this.requireVenue(venueId);
    const currency = venue.priceFromCurrency ?? 'EGP';
    this.assertCurrency(dto.currency, currency);
    this.assertReceipt(dto.receiptUrl);

    const result = await this.prisma.$transaction(async (tx) => {
      const balance = await this.ledger.getBalance(venueId, currency, tx);
      if (dto.expectedBalance != null && dto.expectedBalance !== balance) {
        throw new ApiException(HttpStatus.CONFLICT, 'BALANCE_CHANGED', 'Balance changed since the screen loaded');
      }
      const history = await tx.venueLedgerEntry.count({ where: { venueId } });
      if (history === 0 && !dto.allowOverpay) {
        throw new BadRequestException('Venue has no ledger history');
      }
      if (dto.amount > Math.max(0, balance) && !dto.allowOverpay) {
        throw new BadRequestException('Amount exceeds current positive balance');
      }
      const settlement = await tx.venueSettlement.create({
        data: {
          venueId,
          direction: 'platform_to_owner',
          amount: dto.amount,
          currency,
          method: dto.method,
          reference: dto.reference,
          note: dto.note,
          receiptUrl: dto.receiptUrl,
          status: 'confirmed',
          recordedById: admin.id,
          confirmedById: admin.id,
          confirmedAt: new Date(),
        },
      });
      await this.ledger.recordPayout(tx, {
        venueId,
        currency,
        amount: dto.amount,
        settlementId: settlement.id,
        reason: dto.reason,
        createdById: admin.id,
      });
      await tx.auditLogEntry.create({
        data: {
          actorUserId: admin.id,
          action: 'venue.settlement.payout',
          targetType: 'settlement',
          targetId: settlement.id,
          metadata: {
            venueId,
            amount: dto.amount,
            previousBalance: balance,
            allowOverpay: !!dto.allowOverpay,
            reason: dto.reason,
          },
        },
      });
      const nextBalance = await this.ledger.getBalance(venueId, currency, tx);
      return { settlement, previousBalance: balance, balance: nextBalance };
    });

    await this.notifyPayout(venue.ownerId, venueId, dto.amount, dto.method, result.balance, currency);
    if (idempotencyKey) {
      await this.prisma.idempotencyKey.create({
        data: {
          key: `${admin.id}:${idempotencyKey}`,
          userId: admin.id,
          responseBody: result as object,
          statusCode: 200,
        },
      }).catch(() => undefined);
    }
    return result;
  }

  async recordRemittance(admin: AuthenticatedUser, venueId: string, dto: AdminPayoutDto) {
    const venue = await this.requireVenue(venueId);
    const currency = venue.priceFromCurrency ?? 'EGP';
    this.assertCurrency(dto.currency, currency);
    this.assertReceipt(dto.receiptUrl);
    const result = await this.prisma.$transaction(async (tx) => {
      const settlement = await tx.venueSettlement.create({
        data: {
          venueId,
          direction: 'owner_to_platform',
          amount: dto.amount,
          currency,
          method: dto.method,
          reference: dto.reference,
          note: dto.note,
          receiptUrl: dto.receiptUrl,
          status: 'confirmed',
          recordedById: admin.id,
          confirmedById: admin.id,
          confirmedAt: new Date(),
        },
      });
      await this.ledger.recordRemittance(tx, {
        venueId,
        currency,
        amount: dto.amount,
        settlementId: settlement.id,
        reason: dto.reason,
        createdById: admin.id,
      });
      await tx.auditLogEntry.create({
        data: {
          actorUserId: admin.id,
          action: 'venue.settlement.remittance',
          targetType: 'settlement',
          targetId: settlement.id,
          metadata: { venueId, amount: dto.amount, reason: dto.reason },
        },
      });
      return { settlement, balance: await this.ledger.getBalance(venueId, currency, tx) };
    });
    await notifyFinance(this.notifications, {
      userId: venue.ownerId,
      titleEn: `We recorded a ${formatMoney(dto.amount, currency)} payment to Matchena`,
      titleAr: `سجّلنا دفعة ${formatMoney(dto.amount, currency, 'ar')} لماتشنا`,
      bodyEn: `Your Matchena account balance is now ${formatMoney(result.balance, currency)}.`,
      bodyAr: `رصيد حساب ماتشنا بقى ${formatMoney(result.balance, currency, 'ar')}.`,
      payload: { venueId, amount: dto.amount },
    });
    return result;
  }

  async listRemittances(status = 'pending_confirmation') {
    return this.prisma.venueSettlement.findMany({
      where: { direction: 'owner_to_platform', status: status as never },
      include: {
        venue: { select: { id: true, nameEn: true, nameAr: true, owner: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async confirmSettlement(admin: AuthenticatedUser, id: string, reason?: string) {
    const settlement = await this.prisma.venueSettlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundException('Settlement not found');
    if (settlement.status !== 'pending_confirmation') {
      throw new BadRequestException('Only pending remittances can be confirmed');
    }
    const venue = await this.requireVenue(settlement.venueId);
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.venueSettlement.update({
        where: { id },
        data: {
          status: 'confirmed',
          confirmedById: admin.id,
          confirmedAt: new Date(),
        },
      });
      await this.ledger.recordRemittance(tx, {
        venueId: settlement.venueId,
        currency: settlement.currency,
        amount: settlement.amount,
        settlementId: id,
        reason: reason ?? 'remittance_confirmed',
        createdById: admin.id,
      });
      await tx.auditLogEntry.create({
        data: {
          actorUserId: admin.id,
          action: 'venue.settlement.confirmed',
          targetType: 'settlement',
          targetId: id,
          metadata: { venueId: settlement.venueId, reason: reason ?? null, amount: settlement.amount },
        },
      });
      return {
        settlement: updated,
        balance: await this.ledger.getBalance(settlement.venueId, settlement.currency, tx),
      };
    });
    await notifyFinance(this.notifications, {
      userId: venue.ownerId,
      titleEn: `Matchena confirmed your ${formatMoney(settlement.amount, settlement.currency)} payment`,
      titleAr: `ماتشنا أكّدت دفعتك ${formatMoney(settlement.amount, settlement.currency, 'ar')}`,
      bodyEn: `Your account balance is now ${formatMoney(result.balance, settlement.currency)}.`,
      bodyAr: `رصيد الحساب بقى ${formatMoney(result.balance, settlement.currency, 'ar')}.`,
      payload: { venueId: settlement.venueId, settlementId: id },
    });
    return result;
  }

  async rejectSettlement(admin: AuthenticatedUser, id: string, reason: string) {
    const settlement = await this.prisma.venueSettlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundException('Settlement not found');
    if (settlement.status !== 'pending_confirmation') {
      throw new BadRequestException('Only pending remittances can be rejected');
    }
    const venue = await this.requireVenue(settlement.venueId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.venueSettlement.update({
        where: { id },
        data: { status: 'rejected', rejectionReason: reason },
      });
      await tx.auditLogEntry.create({
        data: {
          actorUserId: admin.id,
          action: 'venue.settlement.rejected',
          targetType: 'settlement',
          targetId: id,
          metadata: { venueId: settlement.venueId, reason },
        },
      });
      return row;
    });
    await notifyFinance(this.notifications, {
      userId: venue.ownerId,
      titleEn: 'Matchena could not confirm your payment',
      titleAr: 'ماتشنا مقدرتش تأكد دفعتك',
      bodyEn: reason,
      bodyAr: reason,
      payload: { venueId: settlement.venueId, settlementId: id },
    });
    return updated;
  }

  async adjustment(admin: AuthenticatedUser, venueId: string, dto: AdminAdjustmentDto) {
    if (dto.amount === 0 || !Number.isInteger(dto.amount)) {
      throw new BadRequestException('amount must be a non-zero integer');
    }
    const venue = await this.requireVenue(venueId);
    const currency = venue.priceFromCurrency ?? 'EGP';
    const entry = await this.prisma.$transaction(async (tx) => {
      const row = await tx.venueLedgerEntry.create({
        data: {
          venueId,
          currency,
          kind: 'manual_adjustment',
          amount: dto.amount,
          reason: dto.reason,
          createdById: admin.id,
        },
      });
      await tx.auditLogEntry.create({
        data: {
          actorUserId: admin.id,
          action: 'venue.ledger.adjustment',
          targetType: 'venue',
          targetId: venueId,
          metadata: { amount: dto.amount, reason: dto.reason, entryId: row.id },
        },
      });
      return row;
    });
    const balance = await this.ledger.getBalance(venueId, currency);
    await notifyFinance(this.notifications, {
      userId: venue.ownerId,
      titleEn: 'Matchena adjusted your account',
      titleAr: 'ماتشنا عدّلت حسابك',
      bodyEn: `${formatMoney(dto.amount, currency)}. Balance is now ${formatMoney(balance, currency)}.`,
      bodyAr: `${formatMoney(dto.amount, currency, 'ar')}. الرصيد بقى ${formatMoney(balance, currency, 'ar')}.`,
      payload: { venueId, amount: dto.amount },
    });
    return { entry, balance };
  }

  async verify(admin: AuthenticatedUser, venueId: string, repair: boolean, reason: string) {
    await this.requireVenue(venueId);
    const report = await this.ledger.verifyLedgerIntegrity(venueId);
    if (repair) {
      for (const issue of report.issues) {
        if (issue.bookingId) {
          await this.prisma.$transaction((tx) =>
            this.ledger.syncBookingLedger(tx, issue.bookingId!, 'admin_repair'),
          );
        }
      }
      await this.prisma.auditLogEntry.create({
        data: {
          actorUserId: admin.id,
          action: 'venue.ledger.repaired',
          targetType: 'venue',
          targetId: venueId,
          metadata: { reason, issues: report.issues.length },
        },
      });
      return this.ledger.verifyLedgerIntegrity(venueId);
    }
    return report;
  }

  async venueOverview(admin: AuthenticatedUser, venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      include: {
        owner: { select: { id: true, name: true, phone: true, email: true } },
        courts: { include: { sport: true } },
      },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    const actor = this.adminUser(admin);
    const [settings, today, week, month, platformCount, manualCount, noShows, cancels, lastManual, lastBooking] =
      await Promise.all([
        this.financeSettings(venueId),
        this.summary.getSummary(actor, venueId, 'today'),
        this.summary.getSummary(actor, venueId, 'this_week'),
        this.summary.getSummary(actor, venueId, 'this_month'),
        this.prisma.booking.count({ where: { venueId, source: 'platform', status: { not: 'cancelled' } } }),
        this.prisma.booking.count({ where: { venueId, source: 'manual', status: { not: 'cancelled' } } }),
        this.prisma.booking.count({
          where: {
            venueId,
            status: 'no_show',
            slotStart: { gte: new Date(Date.now() - 30 * 86_400_000) },
          },
        }),
        this.prisma.booking.count({
          where: {
            venueId,
            status: 'cancelled',
            slotStart: { gte: new Date(Date.now() - 30 * 86_400_000) },
          },
        }),
        this.prisma.booking.findFirst({
          where: { venueId, source: 'manual' },
          orderBy: { updatedAt: 'desc' },
          select: { updatedAt: true },
        }),
        this.prisma.booking.findFirst({
          where: { venueId },
          orderBy: { updatedAt: 'desc' },
          select: { updatedAt: true },
        }),
      ]);
    const recent = await this.prisma.booking.count({
      where: { venueId, slotStart: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    });
    return {
      venue: {
        id: venue.id,
        nameEn: venue.nameEn,
        nameAr: venue.nameAr,
        status: venue.status,
        owner: venue.owner,
        sports: [...new Set(venue.courts.map((c) => c.sport.nameEn))],
        units: venue.courts.length,
      },
      ...settings,
      kpis: { today, thisWeek: week, thisMonth: month },
      platformBookings: platformCount,
      manualBookings: { count: manualCount, declaredByOwner: true },
      noShowRate30d: recent ? noShows / recent : 0,
      cancellationRate30d: recent ? cancels / recent : 0,
      lastManualEntryAt: lastManual?.updatedAt ?? null,
      lastBookingUpdateAt: lastBooking?.updatedAt ?? null,
      ratingAvg: venue.ratingAvg,
      ratingCount: venue.ratingCount,
    };
  }

  venueSummary(admin: AuthenticatedUser, venueId: string, range?: string, from?: string, to?: string) {
    return this.summary.getSummary(this.adminUser(admin), venueId, range ?? 'today', from, to);
  }

  async venueBookings(
    admin: AuthenticatedUser,
    venueId: string,
    query: Parameters<OwnerBookingsService['listReportBookings']>[1],
  ) {
    const page = await this.ownerBookings.listReportBookings(this.adminUser(admin), { ...query, venueId });
    const ids = page.items.map((i) => i.id);
    const extras = ids.length
      ? await this.prisma.booking.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            feeAmount: true,
            discountAmount: true,
            ownerFundedDiscount: true,
            commissionBps: true,
            commissionAmount: true,
            ownerNetAmount: true,
            paymentModeSnapshot: true,
            createdByUserId: true,
          },
        })
      : [];
    const extraMap = new Map(extras.map((e) => [e.id, e]));
    return {
      items: page.items.map((row) => {
        const extra = extraMap.get(row.id);
        return {
          ...row,
          feeAmount: extra?.feeAmount,
          platformFundedDiscount: extra
            ? extra.discountAmount - extra.ownerFundedDiscount
            : undefined,
          ownerFundedDiscount: extra?.ownerFundedDiscount,
          commissionBps: extra?.commissionBps,
          commissionAmount: extra?.commissionAmount,
          ownerNetAmount: extra?.ownerNetAmount,
          paymentModeSnapshot: extra?.paymentModeSnapshot,
          createdByUserId: extra?.createdByUserId,
          ledgerDelta: extra?.ownerNetAmount ?? 0,
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  venueCustomers(admin: AuthenticatedUser, venueId: string) {
    return this.owner.customers(this.adminUser(admin), venueId);
  }

  venueBoard(admin: AuthenticatedUser, venueId: string, date: string) {
    return this.owner.board(this.adminUser(admin), venueId, date);
  }

  venueCalendar(admin: AuthenticatedUser, venueId: string, date: string) {
    return this.owner.calendar(this.adminUser(admin), venueId, date);
  }

  async availability(venueId: string) {
    await this.requireVenue(venueId);
    const courts = await this.prisma.court.findMany({ where: { venueId }, orderBy: { name: 'asc' } });
    const days: string[] = [];
    const tzNow = new Date();
    for (let i = 0; i < 8; i++) {
      const d = new Date(tzNow.getTime() + i * 86_400_000);
      days.push(d.toISOString().slice(0, 10));
    }
    const units: Array<{
      courtId: string;
      name: string;
      freeMinutes: number;
      bookedPlatformMinutes: number;
      bookedManualMinutes: number;
      lastUpdated: Date;
      days: Array<{ date: string; slots: number; states: string[] }>;
    }> = [];
    for (const court of courts) {
      let freeMinutes = 0;
      let bookedPlatformMinutes = 0;
      let bookedManualMinutes = 0;
      const daysOut: Array<{ date: string; slots: number; states: string[] }> = [];
      for (const date of days) {
        const slots = await this.bookings.getSlotGrid(court.id, date);
        const step = court.slotDurationMins;
        let lastUpdated = new Date(0);
        const states = slots.map((s) => {
          if (s.state === 'available' || s.state === 'past') freeMinutes += step;
          return s.state;
        });
        daysOut.push({ date, slots: slots.length, states });
        void lastUpdated;
      }
      const bookings = await this.prisma.booking.findMany({
        where: {
          courtId: court.id,
          slotStart: { gte: tzNow, lt: new Date(tzNow.getTime() + 8 * 86_400_000) },
          status: { in: ['held', 'confirmed', 'completed'] },
        },
        select: { source: true, slotStart: true, slotEnd: true, updatedAt: true },
      });
      for (const b of bookings) {
        const mins = Math.round((b.slotEnd.getTime() - b.slotStart.getTime()) / 60_000);
        if (b.source === 'platform') bookedPlatformMinutes += mins;
        else bookedManualMinutes += mins;
      }
      units.push({
        courtId: court.id,
        name: court.name,
        freeMinutes,
        bookedPlatformMinutes,
        bookedManualMinutes,
        lastUpdated: bookings.reduce((m, b) => (b.updatedAt > m ? b.updatedAt : m), new Date(0)),
        days: daysOut,
      });
    }
    return { venueId, units };
  }

  async viewAsOwnerContext(admin: AuthenticatedUser, venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      include: { owner: { select: { id: true, name: true } } },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    const since = new Date(Date.now() - 10 * 60_000);
    const recent = await this.prisma.auditLogEntry.findFirst({
      where: {
        actorUserId: admin.id,
        action: 'admin.view_as_owner',
        targetId: venueId,
        createdAt: { gte: since },
      },
    });
    if (!recent) {
      await this.prisma.auditLogEntry.create({
        data: {
          actorUserId: admin.id,
          action: 'admin.view_as_owner',
          targetType: 'venue',
          targetId: venueId,
          metadata: { venueId, ownerId: venue.ownerId },
        },
      });
    }
    return {
      ownerDisplayName: venue.owner.name,
      venues: [{ id: venue.id, nameEn: venue.nameEn, nameAr: venue.nameAr }],
      featureFlags: { matchenaAccount: true, manualBookings: true },
    };
  }

  async platformKpis() {
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    const [gmv, feeSum, commissionSum, discountSum, balances, pending, top] = await Promise.all([
      this.prisma.booking.aggregate({
        where: { source: 'platform', status: { not: 'cancelled' }, slotStart: { gte: monthAgo } },
        _sum: { totalAmount: true },
      }),
      this.prisma.booking.aggregate({
        where: { source: 'platform', status: { in: ['completed', 'confirmed'] }, paymentStatus: 'paid' },
        _sum: { feeAmount: true, commissionAmount: true, discountAmount: true, ownerFundedDiscount: true },
      }),
      this.prisma.booking.aggregate({
        where: { source: 'platform' },
        _sum: { commissionAmount: true },
      }),
      this.prisma.booking.aggregate({
        where: { source: 'platform' },
        _sum: { discountAmount: true, ownerFundedDiscount: true },
      }),
      this.prisma.venueLedgerEntry.groupBy({
        by: ['venueId', 'currency'],
        _sum: { amount: true },
      }),
      this.prisma.venueSettlement.count({ where: { status: 'pending_confirmation' } }),
      this.prisma.booking.groupBy({
        by: ['venueId'],
        where: { source: 'platform', status: { not: 'cancelled' }, slotStart: { gte: monthAgo } },
        _sum: { totalAmount: true },
        orderBy: { _sum: { totalAmount: 'desc' } },
        take: 5,
      }),
    ]);
    void commissionSum;
    void discountSum;
    const platformFunded = Math.max(
      0,
      (feeSum._sum.discountAmount ?? 0) - (feeSum._sum.ownerFundedDiscount ?? 0),
    );
    const platformRevenue = (feeSum._sum.feeAmount ?? 0) + (feeSum._sum.commissionAmount ?? 0) - platformFunded;
    let owedToOwners = 0;
    let owedByOwners = 0;
    for (const row of balances) {
      const n = row._sum.amount ?? 0;
      if (n > 0) owedToOwners += n;
      if (n < 0) owedByOwners += -n;
    }
    const venueNames = await this.prisma.venue.findMany({
      where: { id: { in: top.map((t) => t.venueId) } },
      select: { id: true, nameEn: true },
    });
    const nameMap = new Map(venueNames.map((v) => [v.id, v.nameEn]));
    const stale = await this.staleVenues();
    return {
      gmv: gmv._sum.totalAmount ?? 0,
      platformRevenue,
      totalOwedToOwners: owedToOwners,
      totalOwedByOwners: owedByOwners,
      pendingRemittances: pending,
      topVenuesByGmv: top.map((t) => ({
        venueId: t.venueId,
        name: nameMap.get(t.venueId),
        gmv: t._sum.totalAmount ?? 0,
      })),
      staleAvailabilityVenueIds: stale.map((v) => v.id),
      staleVenues: stale,
    };
  }

  /** Venues with units but no booking activity for a week — returned with their
   *  names, because a screen full of UUIDs tells the admin nothing. */
  private async staleVenues() {
    const cutoff = new Date(Date.now() - 7 * 86_400_000);
    const active = await this.prisma.booking.findMany({
      where: { updatedAt: { gte: cutoff } },
      distinct: ['venueId'],
      select: { venueId: true },
    });
    const activeIds = new Set(active.map((a) => a.venueId));
    const venues = await this.prisma.venue.findMany({
      where: { status: 'active', courts: { some: {} } },
      select: {
        id: true,
        nameEn: true,
        nameAr: true,
        owner: { select: { id: true, name: true } },
        bookings: { select: { updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
      },
    });
    return venues
      .filter((v) => !activeIds.has(v.id))
      .map((v) => ({
        id: v.id,
        nameEn: v.nameEn,
        nameAr: v.nameAr,
        ownerName: v.owner?.name ?? null,
        lastActivityAt: v.bookings[0]?.updatedAt ?? null,
      }));
  }

  private async notifyPayout(
    ownerId: string,
    venueId: string,
    amount: number,
    method: string,
    balance: number,
    currency: string,
  ) {
    await notifyFinance(this.notifications, {
      userId: ownerId,
      titleEn: `Matchena sent you ${formatMoney(amount, currency)}`,
      titleAr: `ماتشنا بعتتلك ${formatMoney(amount, currency, 'ar')}`,
      bodyEn: `Sent via ${method}. Your account balance is now ${formatMoney(balance, currency)}.`,
      bodyAr: `عن طريق ${method}. رصيد الحساب بقى ${formatMoney(balance, currency, 'ar')}.`,
      payload: { venueId, amount, method, balance },
    });
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { email: true },
    });
    if (owner?.email) {
      await this.email
        .sendFinanceNotice(
          owner.email,
          `Matchena sent you ${formatMoney(amount, currency)}`,
          `Matchena sent you ${formatMoney(amount, currency)} via ${method}. Your account balance is now ${formatMoney(balance, currency)}.\nماتشنا بعتتلك ${formatMoney(amount, currency, 'ar')} عن طريق ${method}. رصيدك بقى ${formatMoney(balance, currency, 'ar')}.`,
        )
        .catch(() => undefined);
    }
  }

  private assertCurrency(got: string, expected: string) {
    if (got !== expected) {
      throw new BadRequestException(`currency must be ${expected}`);
    }
  }

  private assertReceipt(url?: string) {
    if (!url) return;
    if (isSafeReceiptUrl(url, this.config.get<string>('S3_PUBLIC_BASE'))) return;
    throw new BadRequestException('receiptUrl must point to Matchena storage');
  }

  private async requireVenue(venueId: string) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    return venue;
  }
}
