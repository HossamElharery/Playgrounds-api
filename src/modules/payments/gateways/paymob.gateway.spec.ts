import { PaymobGateway, paymobHmacInput, paymobSign } from './paymob.gateway';
import { createGateway } from './create-gateway';
import { DisabledGateway } from './disabled.gateway';
import { GatewayError, InvalidWebhookSignatureError } from '../payment-gateway.interface';

const SECRET = 'hmac-secret-for-tests';

/** Shaped like Paymob's "transaction processed" callback `obj`. */
const txn = (over: Record<string, unknown> = {}) => ({
  id: 987654,
  pending: false,
  amount_cents: 40000,
  success: true,
  is_auth: false,
  is_capture: false,
  is_standalone_payment: true,
  is_voided: false,
  is_refunded: false,
  is_3d_secure: true,
  integration_id: 4001,
  has_parent_transaction: false,
  order: { id: 555, merchant_order_id: 'intent-1' },
  created_at: '2026-10-20T10:00:00.000000',
  currency: 'EGP',
  error_occured: false,
  owner: 77,
  source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' },
  ...over,
});

function gateway(fetchImpl?: typeof fetch) {
  return new PaymobGateway({ secretKey: 'sk_test_key', publicKey: 'pk_test_key', hmacSecret: SECRET, integrationIds: [4001], fetchImpl });
}
const signed = (obj: Record<string, unknown>) => ({ body: { obj }, query: { hmac: paymobSign(obj, SECRET) }, headers: {} });

describe('PaymobGateway', () => {
  it('builds the HMAC input in Paymob\'s documented field order', () => {
    expect(paymobHmacInput(txn())).toBe(
      '40000' + '2026-10-20T10:00:00.000000' + 'EGP' + 'false' + 'false' + '987654' + '4001' + 'true' + 'false' + 'false' + 'false' + 'true' + 'false' + '555' + '77' + 'false' + '2346' + 'MasterCard' + 'card' + 'true',
    );
  });

  it('accepts a correctly signed successful payment', () => {
    const event = gateway().parseWebhook(signed(txn()));
    expect(event).toMatchObject({ intentId: 'intent-1', status: 'paid', amount: 40000, currency: 'EGP', providerPaymentRef: '987654', providerOrderRef: '555' });
  });

  it('rejects a missing, wrong or tampered signature', () => {
    const g = gateway();
    const ok = signed(txn());
    expect(() => g.parseWebhook({ body: ok.body, query: {}, headers: {} })).toThrow(InvalidWebhookSignatureError);
    expect(() => g.parseWebhook({ body: ok.body, query: { hmac: 'ab'.repeat(64) }, headers: {} })).toThrow(InvalidWebhookSignatureError);
    expect(() => g.parseWebhook({ body: ok.body, query: { hmac: 'zz' }, headers: {} })).toThrow(InvalidWebhookSignatureError);
    // amount changed after signing
    const forged = { body: { obj: txn({ amount_cents: 1 }) }, query: ok.query, headers: {} };
    expect(() => g.parseWebhook(forged)).toThrow(InvalidWebhookSignatureError);
    // signed with another secret
    const other = { body: ok.body, query: { hmac: paymobSign(txn(), 'other-secret') }, headers: {} };
    expect(() => g.parseWebhook(other)).toThrow(InvalidWebhookSignatureError);
    expect(() => g.parseWebhook({ body: {}, query: {}, headers: {} })).toThrow(InvalidWebhookSignatureError);
  });

  it('maps the statuses', () => {
    const g = gateway();
    expect(g.parseWebhook(signed(txn({ success: false }))).status).toBe('failed');
    expect(g.parseWebhook(signed(txn({ success: false, pending: true }))).status).toBe('pending');
    expect(g.parseWebhook(signed(txn({ is_voided: true }))).status).toBe('voided');
    expect(g.parseWebhook(signed(txn({ is_refunded: true }))).status).toBe('refunded');
  });

  it('gives each distinct outcome of a transaction its own event id and repeats the same id for a repeat', () => {
    const g = gateway();
    const a = g.parseWebhook(signed(txn()));
    const b = g.parseWebhook(signed(txn()));
    const c = g.parseWebhook(signed(txn({ is_refunded: true })));
    expect(a.eventId).toBe(b.eventId);
    expect(c.eventId).not.toBe(a.eventId);
  });

  it('rejects a signed notification without our reference', () => {
    expect(() => gateway().parseWebhook(signed(txn({ order: { id: 1 } })))).toThrow(GatewayError);
  });

  it('creates an intention and returns the hosted checkout', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ client_secret: 'cs_123', intention_order_id: 555 }), { status: 201 });
    }) as unknown as typeof fetch;
    const session = await gateway(fetchImpl).createCheckout({
      intentId: 'intent-1', amount: 40000, currency: 'EGP', description: 'Venue · MAT-1',
      customer: { name: 'Sara Ali', email: 'sara@example.com', phone: '+201000000000' },
      returnUrl: 'https://app/return', webhookUrl: 'https://api/hook',
    });
    expect(session.providerOrderRef).toBe('555');
    expect(session.checkoutUrl).toContain('/unifiedcheckout/?publicKey=pk_test_key&clientSecret=cs_123');
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent).toMatchObject({ amount: 40000, currency: 'EGP', special_reference: 'intent-1', notification_url: 'https://api/hook', redirection_url: 'https://app/return' });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Token sk_test_key');
  });

  it('turns provider errors into GatewayError without leaking the response body', async () => {
    const fetchImpl = (async () => new Response('{"card":"4111 1111 1111 1111"}', { status: 503 })) as unknown as typeof fetch;
    const failure = await gateway(fetchImpl)
      .createCheckout({ intentId: 'i', amount: 1, currency: 'EGP', description: 'x', customer: {}, returnUrl: 'r', webhookUrl: 'w' })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).retryable).toBe(true);
    expect((failure as GatewayError).message).not.toContain('4111');
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(gateway(down).refund({ providerPaymentRef: '1', amount: 1, currency: 'EGP', idempotencyKey: 'k' })).rejects.toBeInstanceOf(GatewayError);
  });

  it('refunds by transaction id', async () => {
    let body: unknown;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: 4242, success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await gateway(fetchImpl).refund({ providerPaymentRef: '987654', amount: 15000, currency: 'EGP', idempotencyKey: 'k' });
    expect(result.providerRefundRef).toBe('4242');
    expect(body).toEqual({ transaction_id: 987654, amount_cents: 15000 });
  });
});

describe('createGateway', () => {
  const cfg = (values: Record<string, string>) => ({ get: (k: string) => values[k] });
  it('is the disabled gateway unless paymob is selected', () => {
    for (const value of [undefined, '', 'stripe']) {
      const g = createGateway(cfg({ PAYMENT_GATEWAY: value as string }));
      expect(g).toBeInstanceOf(DisabledGateway);
      expect(g.isLive).toBe(false);
    }
  });
  it('builds paymob from the environment', () => {
    const g = createGateway(cfg({ PAYMENT_GATEWAY: 'paymob', PAYMOB_SECRET_KEY: 'sk', PAYMOB_PUBLIC_KEY: 'pk', PAYMOB_HMAC_SECRET: 'h', PAYMOB_INTEGRATION_IDS: '1, 2' }));
    expect(g.name).toBe('paymob');
    expect(g.isLive).toBe(true);
  });
  it('the disabled gateway refuses everything', async () => {
    const g = new DisabledGateway();
    await expect(g.createCheckout()).rejects.toMatchObject({ status: 503 });
    expect(() => g.parseWebhook()).toThrow();
  });
});
