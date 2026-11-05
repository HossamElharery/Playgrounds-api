import { BadRequestException, ForbiddenException, Injectable, Inject, NotFoundException, Optional } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_PROVIDER, PaymentProvider } from './payment-provider.interface';
import { WALLET_TOP_UP_METHODS } from './dto/top-up-wallet.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { AdminAlertsService } from '../notifications/admin-alerts.service';
import { moneyText } from '../../common/money/money-text';

type WalletDb = Prisma.TransactionClient | PrismaService;

export type WalletDebitReason = 'booking' | 'bundle' | 'membership' | 'tournament' | 'withdrawal';
export type WalletCreditReason = 'topup' | 'refund';

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
    private readonly notifications: NotificationsService,
    @Optional() private readonly adminAlerts?: AdminAlertsService,
  ) {}

  async get(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        walletBalance: true,
        coinsBalance: true,
        countryCode: true,
        country: { select: { currency: true, paymentMethods: true } },
      },
    });
    if (!user) throw new BadRequestException('USER_NOT_FOUND');

    const ledger = await this.prisma.walletLedgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      walletBalance: user.walletBalance,
      coinsBalance: user.coinsBalance,
      currency: user.country.currency,
      allowedTopUpMethods: this.topUpMethodsFor(user.country.paymentMethods),
      ledger,
    };
  }

  async topUp(userId: string, amount: number, method: PaymentMethod) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        country: { select: { currency: true, paymentMethods: true, code: true } },
      },
    });
    if (!user) throw new BadRequestException('USER_NOT_FOUND');

    const allowed = this.topUpMethodsFor(user.country.paymentMethods);
    if (!allowed.includes(method)) {
      throw new BadRequestException(
        `Payment method not available for wallet top-up in ${user.country.code}`,
      );
    }

    const charge = await this.paymentProvider.charge(
      amount,
      user.country.currency,
      method,
    );
    if (charge.status !== 'paid') {
      throw new BadRequestException('PAYMENT_FAILED');
    }

    await this.credit(this.prisma, {
      userId,
      amount,
      reason: 'topup',
      method,
      providerRef: charge.providerRef,
    });

    return this.get(userId);
  }

  async debit(
    db: WalletDb,
    params: {
      userId: string;
      amount: number;
      reason: WalletDebitReason;
      bookingId?: string;
      /** The currency of `amount`. A wallet is in its owner's country currency, so a charge in any other one is refused, never converted 1:1. */
      currency?: string;
    },
  ): Promise<void> {
    if (params.amount <= 0) return;
    if (params.currency) {
      const owner = await db.user.findUnique({ where: { id: params.userId }, select: { country: { select: { currency: true } } } });
      if (owner && owner.country.currency !== params.currency) {
        throw new BadRequestException({
          message: 'WALLET_CURRENCY_MISMATCH',
          code: 'WALLET_CURRENCY_MISMATCH',
          result: { walletCurrency: owner.country.currency, chargeCurrency: params.currency },
        });
      }
    }

    const spent = await db.user.updateMany({
      where: { id: params.userId, walletBalance: { gte: params.amount } },
      data: { walletBalance: { decrement: params.amount } },
    });
    if (spent.count !== 1) {
      const user = await db.user.findUnique({
        where: { id: params.userId },
        select: { walletBalance: true },
      });
      const walletBalance = user?.walletBalance ?? 0;
      throw new BadRequestException({
        message: 'INSUFFICIENT_WALLET',
        code: 'INSUFFICIENT_WALLET',
        result: {
          walletBalance,
          requiredAmount: params.amount,
          shortfall: Math.max(0, params.amount - walletBalance),
        },
      });
    }

    await db.walletLedgerEntry.create({
      data: {
        userId: params.userId,
        amount: -params.amount,
        reason: params.reason,
        method: 'wallet',
        bookingId: params.bookingId,
      },
    });
  }

  async credit(
    db: WalletDb,
    params: {
      userId: string;
      amount: number;
      reason: WalletCreditReason;
      method?: PaymentMethod;
      bookingId?: string;
      providerRef?: string;
    },
  ): Promise<void> {
    if (params.amount <= 0) return;

    await db.user.update({
      where: { id: params.userId },
      data: { walletBalance: { increment: params.amount } },
    });
    await db.walletLedgerEntry.create({
      data: {
        userId: params.userId,
        amount: params.amount,
        reason: params.reason,
        method: params.method,
        bookingId: params.bookingId,
        providerRef: params.providerRef,
      },
    });
  }

  async requestWithdrawal(userId: string, amount: number, destination: string) {
    const request = await this.prisma.$transaction(async (tx) => {
      await this.debit(tx, { userId, amount, reason: 'withdrawal' });
      return tx.walletWithdrawalRequest.create({
        data: { userId, amount, destination },
      });
    });
    void this.notifyAdminsOfWithdrawal(request.id, userId, amount, destination);
    return request;
  }

  private async notifyAdminsOfWithdrawal(requestId: string, userId: string, amount: number, destination: string) {
    if (!this.adminAlerts) return;
    const user = await this.prisma.user
      .findUnique({ where: { id: userId }, select: { name: true, country: { select: { currency: true } } } })
      .catch(() => null);
    const currency = user?.country?.currency ?? 'EGP';
    const who = user?.name || 'A user';
    await this.adminAlerts.alert({
      dedupKey: `wallet-withdrawal:${requestId}`,
      titleEn: 'New withdrawal request',
      titleAr: 'طلب سحب جديد',
      bodyEn: `${who} asked to withdraw ${moneyText(amount, currency, 'en')} to ${destination}.`,
      bodyAr: `${who} طلب سحب ${moneyText(amount, currency, 'ar')} إلى ${destination}.`,
      deepLink: '/admin/finance',
      payload: { kind: 'wallet_withdrawal', requestId },
    });
  }

  listWithdrawals(status?: 'pending' | 'paid' | 'rejected') {
    return this.prisma.walletWithdrawalRequest.findMany({
      where: status ? { status } : undefined,
      include: { user: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async resolveWithdrawal(
    adminId: string,
    id: string,
    status: 'paid' | 'rejected',
    note?: string,
  ) {
    const request = await this.prisma.walletWithdrawalRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException('Withdrawal request not found');
    if (request.status !== 'pending')
      throw new ForbiddenException('Already resolved');

    const resolved = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.walletWithdrawalRequest.updateMany({
        where: { id, status: 'pending' },
        data: {
          status,
          note,
          resolvedByUserId: adminId,
          resolvedAt: new Date(),
        },
      });
      if (claimed.count !== 1)
        throw new ForbiddenException('Already resolved');

      if (status === 'rejected') {
        await this.credit(tx, {
          userId: request.userId,
          amount: request.amount,
          reason: 'refund',
        });
      }

      return tx.walletWithdrawalRequest.findUniqueOrThrow({ where: { id } });
    });

    await this.notifications
      .create({
        userId: request.userId,
        category: 'bookings',
        titleEn: status === 'paid' ? 'Your withdrawal was sent' : 'Your withdrawal was declined',
        titleAr: status === 'paid' ? 'تم تحويل مبلغ السحب' : 'تم رفض طلب السحب',
        bodyEn: status === 'rejected' ? (note || 'The amount was returned to your wallet.') : undefined,
        bodyAr: status === 'rejected' ? (note || 'المبلغ رجع لمحفظتك.') : undefined,
        deepLink: '/app/wallet',
        payload: { withdrawalId: id, status },
      })
      .catch(() => undefined);

    return resolved;
  }

  private topUpMethodsFor(countryMethods: string[]): PaymentMethod[] {
    const allowed = new Set(WALLET_TOP_UP_METHODS as readonly string[]);
    return countryMethods.filter(
      (m): m is PaymentMethod => allowed.has(m) && m !== 'cash' && m !== 'wallet',
    );
  }
}
