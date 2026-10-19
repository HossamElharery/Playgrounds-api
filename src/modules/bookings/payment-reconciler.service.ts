import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { PrismaService } from '../prisma/prisma.service';
import { withJobLock } from '../../common/utils/job-lock.util';
import { PaymentIntentsService } from './payment-intents.service';
import { Inject } from '@nestjs/common';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../payments/payment-gateway.interface';

const STALE_OPEN_MS = 2 * 60_000;
/** After the hold ends we keep asking the provider for a while: a late payment can still be honoured. */
const EXPIRE_GRACE_MS = 15 * 60_000;
const STUCK_REFUND_MS = 6 * 60 * 60_000;

/**
 * Safety net under the payment notifications. Every minute (one instance at a time):
 *   1. open payments nobody heard back about: ask the provider, then expire the dead ones;
 *   2. refunds owed to players that the provider has not confirmed yet: try again, and
 *      raise an alert for any that stay stuck.
 */
@Injectable()
export class PaymentReconciler {
  private readonly logger = new Logger(PaymentReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intents: PaymentIntentsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  @Cron('15 * * * * *')
  async sweep(): Promise<void> {
    if (!this.gateway.isLive) return;
    try {
      await withJobLock(this.prisma, 'paymentReconciler', async () => {
        await this.reconcile();
      });
    } catch (error) {
      this.logger.warn(`paymentReconciler skipped: ${error instanceof Error ? error.message : error}`);
    }
  }

  async reconcile(now = new Date()): Promise<{ checked: number; expired: number; refunds: number }> {
    const stats = { checked: 0, expired: 0, refunds: 0 };

    const open = await this.prisma.paymentIntent.findMany({
      where: { status: { in: ['created', 'pending'] }, createdAt: { lte: new Date(now.getTime() - STALE_OPEN_MS) } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    for (const intent of open) {
      stats.checked += 1;
      try {
        const event = intent.checkoutUrl
          ? await this.gateway.fetchStatus({ intentId: intent.id, providerOrderRef: intent.providerOrderRef })
          : null;
        if (event) await this.intents.applyEvent(intent.provider, event);
      } catch (error) {
        this.logger.warn(`Status read for intent ${intent.id} failed: ${String(error)}`);
      }
      const dead = !intent.checkoutUrl || intent.expiresAt.getTime() + EXPIRE_GRACE_MS < now.getTime();
      if (dead) {
        const res = await this.prisma.paymentIntent.updateMany({
          where: { id: intent.id, status: { in: ['created', 'pending'] } },
          data: intent.checkoutUrl ? { status: 'expired' } : { status: 'failed', failureCode: 'NO_CHECKOUT' },
        });
        stats.expired += res.count;
      }
    }

    const owed = await this.prisma.paymentIntent.findMany({
      where: { status: 'refund_pending', refundDueAmount: { gt: 0 } },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });
    for (const intent of owed) {
      if (await this.intents.refundDue(intent.id)) {
        stats.refunds += 1;
      } else if (now.getTime() - intent.updatedAt.getTime() > STUCK_REFUND_MS) {
        this.logger.error(`Refund for payment intent ${intent.id} has been stuck for hours`);
        Sentry.captureMessage('Card refund stuck', { level: 'error', tags: { area: 'payment-refund' }, extra: { intentId: intent.id, bookingId: intent.bookingId } });
      }
    }
    return stats;
  }
}
