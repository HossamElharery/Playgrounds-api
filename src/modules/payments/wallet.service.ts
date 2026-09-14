import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_PROVIDER, PaymentProvider } from './payment-provider.interface';
import { WALLET_TOP_UP_METHODS } from './dto/top-up-wallet.dto';

type WalletDb = Prisma.TransactionClient | PrismaService;

export type WalletDebitReason = 'booking' | 'bundle' | 'membership';
export type WalletCreditReason = 'topup' | 'refund';

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
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
    },
  ): Promise<void> {
    if (params.amount <= 0) return;

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

  private topUpMethodsFor(countryMethods: string[]): PaymentMethod[] {
    const allowed = new Set(WALLET_TOP_UP_METHODS as readonly string[]);
    return countryMethods.filter(
      (m): m is PaymentMethod => allowed.has(m) && m !== 'cash' && m !== 'wallet',
    );
  }
}
