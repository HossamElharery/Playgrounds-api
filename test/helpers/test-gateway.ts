import {
  GatewayError,
  InvalidWebhookSignatureError,
  type CheckoutRequest,
  type CheckoutSession,
  type GatewayEvent,
  type GatewayRefundRequest,
  type PaymentGateway,
} from '../../src/modules/payments/payment-gateway.interface';

/** A controllable in-process card gateway for the integration suites. Not live until a test says so. */
export class TestGateway implements PaymentGateway {
  readonly name = 'testpay';
  live = false;
  failCheckout = false;
  failRefund = false;
  checkouts: CheckoutRequest[] = [];
  refunds: GatewayRefundRequest[] = [];
  /** What the provider would answer when asked about an intent. */
  statuses = new Map<string, GatewayEvent>();
  private n = 0;

  get isLive() {
    return this.live;
  }
  reset() {
    this.live = false;
    this.failCheckout = false;
    this.failRefund = false;
    this.checkouts = [];
    this.refunds = [];
    this.statuses.clear();
  }
  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    if (this.failCheckout) throw new GatewayError('down', true);
    this.checkouts.push(req);
    this.n += 1;
    return { providerOrderRef: `order-${req.intentId}`, checkoutUrl: `https://pay.test/checkout/${req.intentId}` };
  }
  /** Tests post `{ sig, event }`; only sig === 'valid' verifies. */
  parseWebhook(input: { body: unknown }): GatewayEvent {
    const body = input.body as { sig?: string; event?: GatewayEvent } | undefined;
    if (body?.sig !== 'valid' || !body.event) throw new InvalidWebhookSignatureError();
    return body.event;
  }
  async fetchStatus(ref: { intentId: string }): Promise<GatewayEvent | null> {
    return this.statuses.get(ref.intentId) ?? null;
  }
  async refund(req: GatewayRefundRequest) {
    if (this.failRefund) throw new GatewayError('down', true);
    this.refunds.push(req);
    return { providerRefundRef: `refund-${req.idempotencyKey}` };
  }
}

export function paidEvent(intent: { id: string; amount: number; currency: string; providerOrderRef?: string | null }, over: Partial<GatewayEvent> = {}): GatewayEvent {
  return {
    eventId: `txn:${intent.id}:paid`,
    intentId: intent.id,
    providerOrderRef: intent.providerOrderRef ?? undefined,
    providerPaymentRef: `pay-${intent.id}`,
    status: 'paid',
    amount: intent.amount,
    currency: intent.currency,
    ...over,
  };
}
