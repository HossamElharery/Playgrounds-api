import { HttpStatus, Inject, Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PaymentIntent } from '@prisma/client';
import * as Sentry from '@sentry/nestjs';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../finance/ledger.service';
import {
  GatewayError,
  PAYMENT_GATEWAY,
  type GatewayEvent,
  type PaymentGateway,
} from '../payments/payment-gateway.interface';
import { BookingsService } from './bookings.service';
import { ApiException } from '../../common/errors/api-exception';
import { lockVenueSlots } from '../../common/utils/slot-lock.util';
import { assertVenueBookable } from '../../common/utils/venue-visibility.util';
import { moneyText } from '../../common/money/money-text';

/** How long a player has to finish paying once they press "Pay". */
export const PAYMENT_WINDOW_MS = 10 * 60_000;

export type ApplyOutcome =
  | 'confirmed'
  | 'revived'
  | 'already_applied'
  | 'duplicate'
  | 'duplicate_payment'
  | 'slot_lost'
  | 'booking_already_confirmed'
  | 'amount_mismatch'
  | 'unknown_intent'
  | 'failed'
  | 'pending'
  | 'cancelled'
  | 'refund_completed'
  | 'needs_review'
  | 'ignored';

export interface PaymentIntentView {
  intentId: string;
  status: PaymentIntent['status'];
  checkoutUrl: string | null;
  amount: number;
  currency: string;
  expiresAt: string;
  holdExpiresAt: string | null;
}

const OPEN: PaymentIntent['status'][] = ['created', 'pending'];

/**
 * Online card payment for a held booking.
 *
 * The browser never confirms a payment. A booking is confirmed only by `applyEvent`, fed by a
 * signature-verified provider notification or by a status read from the provider (reconciler,
 * or the status endpoint while the player waits). Both go through the same idempotent path
 * under the venue's slot lock, so a repeated, reordered or late notification does nothing twice.
 */
@Injectable()
export class PaymentIntentsService {
  private readonly logger = new Logger(PaymentIntentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly bookings: BookingsService,
    private readonly notifications: NotificationsService,
    private readonly ledger: LedgerService,
    private readonly config: ConfigService,
  ) {}

  publicConfig() {
    return { card: { enabled: this.gateway.isLive, provider: this.gateway.isLive ? this.gateway.name : null } };
  }

  /** Payments a person has to look at: unexplained provider events and refunds that keep failing. */
  async needingAttention(limit = 100) {
    const rows = await this.prisma.paymentIntent.findMany({
      where: { status: { in: ['needs_review', 'refund_pending'] } },
      orderBy: { updatedAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        id: true, bookingId: true, userId: true, provider: true, status: true, amount: true, currency: true,
        refundDueAmount: true, failureCode: true, providerPaymentRef: true, paidAt: true, updatedAt: true,
      },
    });
    return rows;
  }

  // ---------------------------------------------------------------- start

  async startPayment(userId: string, bookingId: string, lang: 'ar' | 'en' = 'ar'): Promise<PaymentIntentView> {
    if (!this.gateway.isLive) {
      throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'ONLINE_PAYMENTS_NOT_LIVE', 'Online payments are not available right now');
    }
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { venue: true, user: { select: { name: true, email: true, phone: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.userId !== userId) throw new ForbiddenException('Not your booking');
    if (booking.status !== 'held') {
      throw new ApiException(HttpStatus.CONFLICT, 'BOOKING_NOT_PAYABLE', 'This booking can no longer be paid');
    }
    if (!booking.holdExpiresAt || booking.holdExpiresAt <= new Date()) {
      await this.bookings.releaseUnpaidHold(bookingId);
      throw new ApiException(HttpStatus.CONFLICT, 'HOLD_EXPIRED', 'This hold has expired. Pick a slot again.');
    }
    try {
      assertVenueBookable(booking.venue);
    } catch (error) {
      await this.bookings.releaseUnpaidHold(bookingId);
      throw error;
    }
    const mode = booking.paymentModeSnapshot ?? booking.venue.paymentMode ?? 'at_venue';
    if (mode !== 'online') {
      throw new ApiException(HttpStatus.CONFLICT, 'PAYMENT_MODE_AT_VENUE', 'This venue collects payment at the venue');
    }
    if (booking.totalAmount <= 0) {
      throw new ApiException(HttpStatus.CONFLICT, 'NOTHING_TO_PAY', 'There is nothing to pay for this booking');
    }

    const open = await this.openIntent(bookingId);
    if (open) {
      if (open.checkoutUrl && open.expiresAt > new Date()) return this.view(open, booking.holdExpiresAt);
      if (!open.checkoutUrl && Date.now() - open.createdAt.getTime() < 30_000) {
        throw new ApiException(HttpStatus.CONFLICT, 'PAYMENT_IN_PROGRESS', 'Payment is being prepared, try again in a moment');
      }
      await this.prisma.paymentIntent.updateMany({
        where: { id: open.id, status: { in: OPEN } },
        data: { status: open.checkoutUrl ? 'expired' : 'failed', failureCode: open.checkoutUrl ? null : 'NO_CHECKOUT' },
      });
    }

    // The first time a booking goes to the payment page the hold is stretched to cover it, once.
    const everTried = await this.prisma.paymentIntent.count({ where: { bookingId } });
    let holdExpiresAt = booking.holdExpiresAt;
    if (everTried === 0) {
      const target = new Date(Math.min(Date.now() + PAYMENT_WINDOW_MS, booking.slotStart.getTime()));
      if (target > holdExpiresAt) {
        const extended = await this.prisma.booking.updateMany({
          where: { id: bookingId, status: 'held', holdExpiresAt: { gt: new Date() } },
          data: { holdExpiresAt: target },
        });
        if (extended.count === 1) holdExpiresAt = target;
      }
    }

    let intent: PaymentIntent;
    try {
      intent = await this.prisma.paymentIntent.create({
        data: {
          bookingId,
          userId,
          provider: this.gateway.name,
          amount: booking.totalAmount,
          currency: booking.currency,
          expiresAt: holdExpiresAt,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.openIntent(bookingId);
        if (raced?.checkoutUrl) return this.view(raced, holdExpiresAt);
        throw new ApiException(HttpStatus.CONFLICT, 'PAYMENT_IN_PROGRESS', 'Payment is being prepared, try again in a moment');
      }
      throw error;
    }

    try {
      const session = await this.gateway.createCheckout({
        intentId: intent.id,
        amount: intent.amount,
        currency: intent.currency,
        description: `${booking.venue.nameEn} · ${booking.code}`,
        customer: { name: booking.user.name, email: booking.user.email, phone: booking.user.phone },
        returnUrl: this.returnUrl(bookingId, lang),
        webhookUrl: this.webhookUrl(),
      });
      const saved = await this.prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'pending', providerOrderRef: session.providerOrderRef, checkoutUrl: session.checkoutUrl },
      });
      return this.view(saved, holdExpiresAt);
    } catch (error) {
      await this.prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'failed', failureCode: 'GATEWAY_UNAVAILABLE' },
      });
      if (error instanceof GatewayError) {
        this.logger.error(`Checkout for booking ${bookingId} failed: ${error.message}`);
        Sentry.captureException(error, { tags: { area: 'payment-checkout' }, extra: { bookingId, intentId: intent.id } });
        throw new ApiException(HttpStatus.BAD_GATEWAY, 'PAYMENT_GATEWAY_ERROR', 'The payment provider is not responding. Try again.');
      }
      throw error;
    }
  }

  /** What the app shows while the player waits (and after the redirect back from the provider). */
  async statusFor(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, userId: true, status: true, paymentStatus: true, holdExpiresAt: true, code: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.userId !== userId) throw new ForbiddenException('Not your booking');

    let intent = await this.latestIntent(bookingId);
    // The notification normally arrives within seconds. If it has not, ask the provider
    // directly rather than leave the player staring at a spinner.
    if (intent && OPEN.includes(intent.status) && this.gateway.isLive && Date.now() - intent.updatedAt.getTime() > 8_000) {
      try {
        const event = await this.gateway.fetchStatus({ intentId: intent.id, providerOrderRef: intent.providerOrderRef });
        if (event) await this.applyEvent(this.gateway.name, event);
      } catch (error) {
        this.logger.warn(`Status read for intent ${intent.id} failed: ${String(error)}`);
      }
      intent = await this.latestIntent(bookingId);
      const fresh = await this.prisma.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { status: true, paymentStatus: true, holdExpiresAt: true },
      });
      Object.assign(booking, fresh);
    }
    return {
      booking: {
        id: booking.id,
        code: booking.code,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        holdExpiresAt: booking.holdExpiresAt?.toISOString() ?? null,
      },
      intent: intent ? this.view(intent, booking.holdExpiresAt) : null,
      serverTime: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------- notifications in

  /**
   * Applies one verified provider event. Safe to call any number of times with the same event,
   * from any backend instance, in any order relative to other events for the same payment.
   */
  async applyEvent(provider: string, event: GatewayEvent): Promise<ApplyOutcome> {
    const intent0 = await this.prisma.paymentIntent.findUnique({
      where: { id: event.intentId },
      include: { booking: { select: { venueId: true } } },
    });
    if (!intent0 || intent0.provider !== provider) {
      await this.prisma.paymentWebhookEvent
        .create({ data: { provider, eventId: event.eventId, intentId: null, status: event.status, outcome: 'unknown_intent', processedAt: new Date() } })
        .catch(() => undefined);
      this.logger.warn(`Payment event ${event.eventId} for unknown intent ${event.intentId}`);
      return 'unknown_intent';
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        await lockVenueSlots(tx, intent0.booking.venueId);
        const seen = await tx.paymentWebhookEvent.findUnique({ where: { provider_eventId: { provider, eventId: event.eventId } } });
        if (seen?.processedAt) return { outcome: 'duplicate' as ApplyOutcome, refundIntentId: undefined as string | undefined };
        if (!seen) {
          await tx.paymentWebhookEvent.create({
            data: { provider, eventId: event.eventId, intentId: intent0.id, status: event.status },
          });
        }
        await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${intent0.id} FOR UPDATE`;
        const intent = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intent0.id } });
        const refundIntent: { id?: string } = {};
        const outcome = await this.transition(tx, intent, event, refundIntent);
        await tx.paymentWebhookEvent.update({
          where: { provider_eventId: { provider, eventId: event.eventId } },
          data: { outcome, processedAt: new Date() },
        });
        return { outcome, refundIntentId: refundIntent.id };
      },
      { timeout: 20_000 },
    );

    await this.afterCommit(result.refundIntentId ?? intent0.id, intent0.bookingId, result.outcome);
    return result.outcome;
  }

  private async transition(tx: Prisma.TransactionClient, intent: PaymentIntent, event: GatewayEvent, refundIntent: { id?: string }): Promise<ApplyOutcome> {
    const settled: PaymentIntent['status'][] = ['paid', 'refund_pending', 'refunded', 'partially_refunded'];
    switch (event.status) {
      case 'paid': {
        if (event.amount !== intent.amount || event.currency.toUpperCase() !== intent.currency.toUpperCase()) {
          if (!settled.includes(intent.status)) {
            await tx.paymentIntent.update({
              where: { id: intent.id },
              data: { status: 'needs_review', failureCode: 'AMOUNT_MISMATCH', providerPaymentRef: event.providerPaymentRef ?? null },
            });
          }
          Sentry.captureMessage('Payment amount does not match the intent', {
            level: 'error',
            tags: { area: 'payment' },
            extra: { intentId: intent.id, expected: intent.amount, got: event.amount, currency: event.currency },
          });
          return 'amount_mismatch';
        }
        const ref = event.providerPaymentRef ?? event.eventId;
        if (settled.includes(intent.status)) {
          if (intent.providerPaymentRef === ref) return 'already_applied';
          // A second, different payment for the same booking: keep the first, refund this one.
          const clone = await tx.paymentIntent.create({
            data: {
              bookingId: intent.bookingId,
              userId: intent.userId,
              provider: intent.provider,
              status: 'refund_pending',
              amount: event.amount,
              currency: intent.currency,
              providerPaymentRef: ref,
              refundDueAmount: event.amount,
              expiresAt: new Date(),
              paidAt: new Date(),
            },
          });
          refundIntent.id = clone.id;
          return 'duplicate_payment';
        }
        const result = await this.bookings.confirmPaidByGateway(tx, intent.bookingId, {
          amount: event.amount,
          currency: intent.currency,
          provider: intent.provider,
          providerPaymentRef: ref,
        });
        if (result === 'confirmed' || result === 'revived') {
          await tx.paymentIntent.update({
            where: { id: intent.id },
            data: {
              status: 'paid',
              paidAt: new Date(),
              providerPaymentRef: ref,
              providerOrderRef: intent.providerOrderRef ?? event.providerOrderRef ?? null,
              failureCode: null,
            },
          });
          return result;
        }
        // The money arrived but the booking cannot be honoured: give it back.
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: {
            status: 'refund_pending',
            paidAt: new Date(),
            providerPaymentRef: ref,
            providerOrderRef: intent.providerOrderRef ?? event.providerOrderRef ?? null,
            refundDueAmount: event.amount,
            failureCode: result === 'slot_lost' ? 'SLOT_LOST' : 'BOOKING_ALREADY_CONFIRMED',
          },
        });
        refundIntent.id = intent.id;
        return result === 'slot_lost' ? 'slot_lost' : 'booking_already_confirmed';
      }
      case 'failed':
        if (OPEN.includes(intent.status)) {
          await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'failed', failureCode: event.failureCode ?? 'DECLINED' } });
          return 'failed';
        }
        return 'ignored';
      case 'pending':
        if (intent.status === 'created') {
          await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'pending' } });
          return 'pending';
        }
        return 'ignored';
      case 'voided':
        if (OPEN.includes(intent.status) || intent.status === 'failed') {
          await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'cancelled' } });
          return 'cancelled';
        }
        if (intent.status === 'paid') {
          await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'needs_review', failureCode: 'VOIDED_AFTER_PAID' } });
          Sentry.captureMessage('Provider voided a payment that confirmed a booking', { level: 'error', extra: { intentId: intent.id } });
          return 'needs_review';
        }
        return 'ignored';
      case 'refunded':
        if (intent.status === 'refund_pending' && intent.refundDueAmount > 0) {
          await this.finishRefund(tx, intent, intent.refundDueAmount, event.providerPaymentRef ?? event.eventId);
          return 'refund_completed';
        }
        if (intent.status === 'paid' || intent.status === 'partially_refunded') {
          // A refund we did not ask for (done in the provider's dashboard): a person must reconcile it.
          await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'needs_review', failureCode: 'PROVIDER_REFUND' } });
          Sentry.captureMessage('Provider refunded a payment outside the app', { level: 'warning', extra: { intentId: intent.id } });
          return 'needs_review';
        }
        return 'ignored';
    }
  }

  /** Records a refund that the provider confirmed: intent, payment row and the venue ledger. */
  private async finishRefund(tx: Prisma.TransactionClient, intent: PaymentIntent, amount: number, providerRefundRef: string) {
    const total = intent.refundedAmount + amount;
    await tx.paymentIntent.update({
      where: { id: intent.id },
      data: {
        refundedAmount: total,
        refundDueAmount: 0,
        status: total >= intent.amount ? 'refunded' : 'partially_refunded',
      },
    });
    const charged = intent.providerPaymentRef
      ? await tx.payment.findFirst({ where: { bookingId: intent.bookingId, providerRef: `gw:${intent.provider}:${intent.providerPaymentRef}` }, select: { id: true } })
      : null;
    if (!charged) return; // never recorded as income (the slot was lost): nothing to reverse
    await tx.payment.create({
      data: {
        bookingId: intent.bookingId,
        amount: -amount,
        currency: intent.currency,
        method: 'card',
        status: 'refunded',
        providerRef: `gwr:${intent.provider}:${providerRefundRef}`,
      },
    });
    await this.ledger.syncBookingLedger(tx, intent.bookingId, 'payment_refunded');
  }

  private async afterCommit(intentId: string, bookingId: string, outcome: ApplyOutcome) {
    try {
      if (outcome === 'confirmed' || outcome === 'revived') {
        await this.bookings.announceConfirmed(bookingId);
        return;
      }
      if (outcome === 'slot_lost' || outcome === 'booking_already_confirmed' || outcome === 'duplicate_payment') {
        await this.tellPlayerRefundDue(intentId);
        await this.refundDue(intentId);
      }
    } catch (error) {
      this.logger.error(`Post-payment step ${outcome} for intent ${intentId} failed: ${String(error)}`);
      Sentry.captureException(error, { tags: { area: 'payment-after-commit', outcome }, extra: { intentId, bookingId } });
    }
  }

  // ---------------------------------------------------------------- refunds

  /**
   * Sends the money owed on an intent back through the provider. Returns true when the
   * provider confirmed. A provider outage leaves the intent `refund_pending` for the reconciler.
   */
  async refundDue(intentId: string): Promise<boolean> {
    const intent = await this.prisma.paymentIntent.findUnique({ where: { id: intentId } });
    if (!intent || intent.status !== 'refund_pending' || intent.refundDueAmount <= 0 || !intent.providerPaymentRef) return false;
    let providerRefundRef: string;
    try {
      const done = await this.gateway.refund({
        providerPaymentRef: intent.providerPaymentRef,
        amount: intent.refundDueAmount,
        currency: intent.currency,
        idempotencyKey: `refund:${intent.id}`,
      });
      providerRefundRef = done.providerRefundRef;
    } catch (error) {
      this.logger.warn(`Refund for intent ${intent.id} not completed: ${String(error)}`);
      return false;
    }
    const finished = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${intent.id} FOR UPDATE`;
      const fresh = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
      if (fresh.status !== 'refund_pending' || fresh.refundDueAmount <= 0) return false;
      await this.finishRefund(tx, fresh, fresh.refundDueAmount, providerRefundRef);
      return true;
    });
    if (finished) await this.tellPlayerRefunded(intent.id).catch(() => undefined);
    return finished;
  }

  private async tellPlayerRefundDue(intentId: string) {
    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
      include: { booking: { select: { code: true, venue: { select: { nameEn: true, nameAr: true } } } } },
    });
    if (!intent) return;
    const money = (l: 'en' | 'ar') => moneyText(intent.refundDueAmount || intent.amount, intent.currency, l);
    await this.notifications.create({
      dedupKey: `payment-refund-due:${intent.id}`,
      userId: intent.userId,
      category: 'bookings',
      titleEn: 'Your payment could not be used',
      titleAr: 'تعذّر استخدام دفعتك',
      bodyEn: `${intent.booking.venue.nameEn}: the time was no longer available, so ${money('en')} is being refunded to your card.`,
      bodyAr: `${intent.booking.venue.nameAr}: الموعد لم يعد متاحًا، فجاري رد ${money('ar')} إلى بطاقتك.`,
      deepLink: '/app/bookings',
      payload: { kind: 'payment_refund_due', bookingId: intent.bookingId, intentId: intent.id },
    });
  }

  private async tellPlayerRefunded(intentId: string) {
    const intent = await this.prisma.paymentIntent.findUnique({ where: { id: intentId } });
    if (!intent) return;
    await this.notifications.create({
      dedupKey: `payment-refunded:${intent.id}`,
      userId: intent.userId,
      category: 'bookings',
      titleEn: 'Refund sent',
      titleAr: 'تم إرسال المبلغ المسترد',
      bodyEn: `${moneyText(intent.refundedAmount, intent.currency, 'en')} was sent back to your card. Your bank may take a few days to show it.`,
      bodyAr: `تم رد ${moneyText(intent.refundedAmount, intent.currency, 'ar')} إلى بطاقتك. قد يستغرق ظهوره في البنك عدة أيام.`,
      deepLink: '/app/bookings',
      payload: { kind: 'payment_refunded', bookingId: intent.bookingId, intentId: intent.id },
    });
  }

  // ------------------------------------------------------------------ helpers

  private openIntent(bookingId: string) {
    return this.prisma.paymentIntent.findFirst({ where: { bookingId, status: { in: OPEN } }, orderBy: { createdAt: 'desc' } });
  }

  private latestIntent(bookingId: string) {
    return this.prisma.paymentIntent.findFirst({ where: { bookingId }, orderBy: { createdAt: 'desc' } });
  }

  private view(intent: PaymentIntent, holdExpiresAt: Date | null): PaymentIntentView {
    return {
      intentId: intent.id,
      status: intent.status,
      checkoutUrl: OPEN.includes(intent.status) ? intent.checkoutUrl : null,
      amount: intent.amount,
      currency: intent.currency,
      expiresAt: intent.expiresAt.toISOString(),
      holdExpiresAt: holdExpiresAt?.toISOString() ?? null,
    };
  }

  private returnUrl(bookingId: string, lang: 'ar' | 'en'): string {
    const base = (this.config.get<string>('PAYMENT_RETURN_BASE_URL') || this.config.get<string>('SITE_URL') || '').replace(/\/$/, '');
    return `${base}/${lang}/app/payment/return?booking=${encodeURIComponent(bookingId)}`;
  }

  private webhookUrl(): string {
    const base = (this.config.get<string>('API_PUBLIC_URL') ?? '').replace(/\/$/, '');
    if (!base) {
      throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'ONLINE_PAYMENTS_NOT_LIVE', 'Online payments are not available right now');
    }
    return `${base}/api/v1/payments/webhooks/${this.gateway.name}`;
  }
}
