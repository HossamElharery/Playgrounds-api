/**
 * A card-payment provider, as the booking flow needs it. The booking code never talks to a
 * provider directly: it creates a PaymentIntent, asks the gateway for a checkout page, and
 * trusts only a *verified* provider notification (or a status read from the provider) to say
 * the money arrived. A redirect back from the provider proves nothing.
 */
export const PAYMENT_GATEWAY = 'PAYMENT_GATEWAY';

export interface CheckoutRequest {
  /** Our PaymentIntent id: sent as the provider's merchant reference and echoed back in notifications. */
  intentId: string;
  /** Minor units of `currency`, copied from the booking on the server. */
  amount: number;
  currency: string;
  description: string;
  customer: { name?: string | null; email?: string | null; phone?: string | null };
  /** Where the provider sends the player's browser afterwards (display only, never proof of payment). */
  returnUrl: string;
  /** Where the provider posts notifications. */
  webhookUrl: string;
}

export interface CheckoutSession {
  providerOrderRef: string;
  checkoutUrl: string;
}

export type GatewayPaymentStatus = 'paid' | 'pending' | 'failed' | 'voided' | 'refunded';

/** A provider notification after its signature was verified, in the shape the booking code uses. */
export interface GatewayEvent {
  /** Unique per distinct provider notification; the same delivery repeated has the same id. */
  eventId: string;
  /** Our PaymentIntent id (the merchant reference). */
  intentId: string;
  providerOrderRef?: string;
  providerPaymentRef?: string;
  status: GatewayPaymentStatus;
  amount: number;
  currency: string;
  failureCode?: string;
}

export interface GatewayRefundRequest {
  providerPaymentRef: string;
  amount: number;
  currency: string;
  /** Stable per refund: asking twice must refund once. */
  idempotencyKey: string;
}

export interface PaymentGateway {
  readonly name: string;
  /** False unless the provider is fully configured. Everything online is off while this is false. */
  readonly isLive: boolean;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  /**
   * Verifies the provider's signature and returns the normalised event.
   * Throws `InvalidWebhookSignatureError` for anything that does not verify.
   */
  parseWebhook(input: { body: unknown; query: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }): GatewayEvent;
  /** Asks the provider what became of a payment (used when a notification never arrived). */
  fetchStatus(ref: { intentId: string; providerOrderRef?: string | null }): Promise<GatewayEvent | null>;
  refund(request: GatewayRefundRequest): Promise<{ providerRefundRef: string }>;
}

export class InvalidWebhookSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
    this.name = 'InvalidWebhookSignatureError';
  }
}

export class GatewayError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'GatewayError';
  }
}
