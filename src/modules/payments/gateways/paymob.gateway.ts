import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  GatewayError,
  InvalidWebhookSignatureError,
  type CheckoutRequest,
  type CheckoutSession,
  type GatewayEvent,
  type GatewayPaymentStatus,
  type GatewayRefundRequest,
  type PaymentGateway,
} from '../payment-gateway.interface';

export interface PaymobConfig {
  secretKey: string;
  publicKey: string;
  hmacSecret: string;
  integrationIds: number[];
  baseUrl?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The fields Paymob signs, in the order it signs them (its "transaction processed callback" HMAC). */
export const PAYMOB_HMAC_FIELDS = [
  'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'id', 'integration_id',
  'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment', 'is_voided', 'order.id',
  'owner', 'pending', 'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success',
] as const;

const pick = (obj: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj);

/** Paymob concatenates the values as text: booleans as true/false, missing values as an empty string. */
export function paymobHmacInput(obj: Record<string, unknown>): string {
  return PAYMOB_HMAC_FIELDS.map((f) => {
    const v = pick(obj, f);
    return v === undefined || v === null ? '' : String(v);
  }).join('');
}

export function paymobSign(obj: Record<string, unknown>, secret: string): string {
  return createHmac('sha512', secret).update(paymobHmacInput(obj)).digest('hex');
}

/**
 * Paymob (Accept) adapter: Intention API checkout + transaction-processed callbacks.
 *
 * Written against Paymob's public documentation and verified with fixtures only. It has NOT been
 * exercised against Paymob's sandbox from here: run the sandbox checklist in MATCHENA_BACKEND.md
 * §13 before setting PAYMENT_GATEWAY=paymob in production.
 */
export class PaymobGateway implements PaymentGateway {
  readonly name = 'paymob';
  readonly isLive = true;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: PaymobConfig) {
    this.base = (cfg.baseUrl ?? 'https://accept.paymob.com').replace(/\/$/, '');
    this.doFetch = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const [first, ...rest] = (req.customer.name ?? 'Matchena player').trim().split(/\s+/);
    const body = {
      amount: req.amount,
      currency: req.currency,
      payment_methods: this.cfg.integrationIds,
      items: [{ name: req.description.slice(0, 50), amount: req.amount, description: req.description.slice(0, 255), quantity: 1 }],
      billing_data: {
        first_name: first || 'Matchena',
        last_name: rest.join(' ') || 'Player',
        email: req.customer.email || 'noreply@matchena.com',
        phone_number: req.customer.phone || 'NA',
        apartment: 'NA', floor: 'NA', street: 'NA', building: 'NA', shipping_method: 'NA', postal_code: 'NA', city: 'NA', country: 'EG', state: 'NA',
      },
      special_reference: req.intentId,
      extras: { intentId: req.intentId },
      notification_url: req.webhookUrl,
      redirection_url: req.returnUrl,
    };
    const res = await this.call('/v1/intention/', body);
    const clientSecret = typeof res['client_secret'] === 'string' ? res['client_secret'] : '';
    const order = res['intention_order_id'] ?? res['id'];
    if (!clientSecret || order === undefined || order === null) throw new GatewayError('Paymob returned an unexpected checkout response');
    const url = `${this.base}/unifiedcheckout/?publicKey=${encodeURIComponent(this.cfg.publicKey)}&clientSecret=${encodeURIComponent(clientSecret)}`;
    return { providerOrderRef: String(order), checkoutUrl: url };
  }

  parseWebhook(input: { body: unknown; query: Record<string, unknown>; headers?: unknown }): GatewayEvent {
    const body = (input.body ?? {}) as { obj?: Record<string, unknown> };
    const obj = body.obj;
    const supplied = typeof input.query?.['hmac'] === 'string' ? (input.query['hmac'] as string) : '';
    if (!obj || typeof obj !== 'object' || !supplied) throw new InvalidWebhookSignatureError('Missing signature');
    const expected = Buffer.from(paymobSign(obj, this.cfg.hmacSecret), 'hex');
    const given = Buffer.from(supplied, 'hex');
    if (expected.length === 0 || given.length !== expected.length || !timingSafeEqual(expected, given)) {
      throw new InvalidWebhookSignatureError();
    }
    return this.toEvent(obj);
  }

  async fetchStatus(ref: { intentId: string; providerOrderRef?: string | null }): Promise<GatewayEvent | null> {
    // Paymob's "transaction inquiry by merchant order id".
    const res = await this.call('/api/ecommerce/orders/transaction_inquiry', { merchant_order_id: ref.intentId, order_id: ref.providerOrderRef ?? undefined });
    if (!res || typeof res !== 'object' || res['id'] === undefined) return null;
    return this.toEvent(res);
  }

  async refund(req: GatewayRefundRequest): Promise<{ providerRefundRef: string }> {
    const res = await this.call('/api/acceptance/void_refund/refund', {
      transaction_id: Number(req.providerPaymentRef) || req.providerPaymentRef,
      amount_cents: req.amount,
    });
    const id = res['id'];
    if (id === undefined || id === null || res['success'] === false) throw new GatewayError('Paymob refused the refund');
    return { providerRefundRef: String(id) };
  }

  private toEvent(obj: Record<string, unknown>): GatewayEvent {
    const order = (obj['order'] ?? {}) as Record<string, unknown>;
    const merchant = order['merchant_order_id'] ?? obj['merchant_order_id'];
    if (merchant === undefined || merchant === null || obj['id'] === undefined) throw new GatewayError('Notification without a merchant reference');
    const truthy = (v: unknown) => v === true || v === 'true';
    let status: GatewayPaymentStatus;
    if (truthy(obj['is_voided'])) status = 'voided';
    else if (truthy(obj['is_refunded'])) status = 'refunded';
    else if (truthy(obj['pending'])) status = 'pending';
    else if (truthy(obj['success'])) status = 'paid';
    else status = 'failed';
    const amount = Number(obj['amount_cents']);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new GatewayError('Notification with an invalid amount');
    return {
      eventId: `txn:${String(obj['id'])}:${status}`,
      intentId: String(merchant),
      providerOrderRef: order['id'] !== undefined ? String(order['id']) : undefined,
      providerPaymentRef: String(obj['id']),
      status,
      amount,
      currency: String(obj['currency'] ?? ''),
      failureCode: status === 'failed' ? String(obj['data.message'] ?? (obj['data'] as Record<string, unknown> | undefined)?.['message'] ?? 'DECLINED').slice(0, 80) : undefined,
    };
  }

  private async call(path: string, body: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.doFetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { Authorization: `Token ${this.cfg.secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        /* a non-JSON answer is handled by the status check below */
      }
      // Never put the response body or the key in the message: it can echo card or customer data.
      if (!res.ok) throw new GatewayError(`Paymob answered HTTP ${res.status}`, res.status >= 500 || res.status === 429);
      return json;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError('Could not reach Paymob', true);
    } finally {
      clearTimeout(timer);
    }
  }
}
