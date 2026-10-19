import {
  bookings, disconnect, futureSlot, gateway, intents, makeUser, makeVenue, prisma, reconciler, seedWorld,
} from './helpers/booking-harness';
import { paidEvent } from './helpers/test-gateway';
import { PaymentsController } from '../src/modules/bookings/payments.controller';

jest.setTimeout(180_000);

const code = (error: unknown) => {
  const body = (error as { getResponse?: () => unknown })?.getResponse?.();
  return (body as { code?: string } | undefined)?.code;
};

describe('card payments (real Postgres, test gateway)', () => {
  let sportId: string;
  beforeAll(async () => {
    ({ sportId } = await seedWorld());
  });
  afterAll(disconnect);
  beforeEach(() => gateway.reset());

  async function world() {
    const owner = await makeUser('owner', ['owner']);
    const { venue, courts } = await makeVenue(owner.row.id, sportId, 1, { paymentMode: 'online' });
    const player = await makeUser('player');
    return { owner, venue, court: courts[0], player };
  }
  const hold = (userId: string, courtId: string, slot: Date) =>
    bookings.holdSlot(userId, { courtId, slotStart: slot.toISOString() });
  const payable = async (offset = 0) => {
    gateway.live = true;
    const w = await world();
    const held = await hold(w.player.row.id, w.court.id, futureSlot(offset));
    return { ...w, held };
  };
  const webhook = async (event: ReturnType<typeof paidEvent>) => intents.applyEvent('testpay', event);
  const fresh = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });
  const intentOf = (bookingId: string) => prisma.paymentIntent.findFirstOrThrow({ where: { bookingId }, orderBy: { createdAt: 'desc' } });

  it('offers no online payment while no gateway is live', async () => {
    const w = await world();
    const held = await hold(w.player.row.id, w.court.id, futureSlot());
    await expect(intents.startPayment(w.player.row.id, held.id)).rejects.toMatchObject({ response: { code: 'ONLINE_PAYMENTS_NOT_LIVE' } });
    expect(intents.publicConfig().card.enabled).toBe(false);
    const confirmed = await bookings.confirmBooking(w.player.row.id, held.id, {} as never);
    expect(confirmed.paymentStatus).toBe('pending'); // pay at venue
  });

  it('refuses to confirm an online booking without a verified payment', async () => {
    const { player, held } = await payable();
    await expect(bookings.confirmBooking(player.row.id, held.id, { paymentMethod: 'card' } as never)).rejects.toMatchObject({
      response: { code: 'PAYMENT_REQUIRED' },
    });
    expect((await fresh(held.id)).status).toBe('held');
  });

  it('confirms only from a verified notification, once, and tells the player and the owner', async () => {
    const { player, owner, held } = await payable();
    const view = await intents.startPayment(player.row.id, held.id);
    expect(view.status).toBe('pending');
    expect(view.checkoutUrl).toContain('https://pay.test/checkout/');
    expect(view.amount).toBe(held.totalAmount); // server amount, never the client's
    expect(gateway.checkouts[0].webhookUrl).toBe('https://api.test/api/v1/payments/webhooks/testpay');
    expect(gateway.checkouts[0].returnUrl).toContain(`/ar/app/payment/return?booking=${held.id}`);

    // pressing Pay again returns the same open checkout
    const again = await intents.startPayment(player.row.id, held.id);
    expect(again.intentId).toBe(view.intentId);
    expect(gateway.checkouts).toHaveLength(1);
    // the hold covers the payment window
    const stretched = await fresh(held.id);
    expect(stretched.holdExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 8 * 60_000);

    const intent = await intentOf(held.id);
    expect(await webhook(paidEvent(intent))).toBe('confirmed');
    const booking = await fresh(held.id);
    expect(booking).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', paymentMethod: 'card' });
    expect(booking.qrPayload).toBeTruthy();
    expect((await intentOf(held.id)).status).toBe('paid');
    const payments = await prisma.payment.findMany({ where: { bookingId: held.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amount: held.totalAmount, method: 'card', status: 'paid' });

    // duplicates and replays change nothing
    expect(await webhook(paidEvent(intent))).toBe('duplicate');
    expect(await webhook(paidEvent(intent, { eventId: 'another-delivery' }))).toBe('already_applied');
    expect(await prisma.payment.count({ where: { bookingId: held.id } })).toBe(1);

    const ownerNotices = await prisma.notification.count({ where: { userId: owner.row.id, dedupKey: { startsWith: `booking-confirmed-owner:${held.id}` } } });
    expect(ownerNotices).toBe(1);
    expect(await prisma.notification.count({ where: { dedupKey: `booking-confirmed-player:${held.id}:${player.row.id}` } })).toBe(1);
    // nothing to confirm again through the old endpoint
    await expect(bookings.confirmBooking(player.row.id, held.id, {} as never)).rejects.toBeDefined();
  });

  it('never confirms when the amount or currency differs from the booking', async () => {
    const { player, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    const intent = await intentOf(held.id);
    expect(await webhook(paidEvent(intent, { amount: intent.amount - 1 }))).toBe('amount_mismatch');
    expect((await fresh(held.id)).status).toBe('held');
    expect((await intentOf(held.id)).status).toBe('needs_review');
    expect(await prisma.payment.count({ where: { bookingId: held.id } })).toBe(0);
  });

  it('ignores unknown intents and failed attempts leave the hold so the player can retry', async () => {
    const { player, held } = await payable();
    expect(await webhook(paidEvent({ id: 'no-such-intent', amount: 1, currency: 'EGP' }))).toBe('unknown_intent');
    await intents.startPayment(player.row.id, held.id);
    const first = await intentOf(held.id);
    expect(await webhook({ ...paidEvent(first), status: 'failed', eventId: 'f1', failureCode: 'DECLINED' })).toBe('failed');
    expect((await fresh(held.id)).status).toBe('held');
    const retry = await intents.startPayment(player.row.id, held.id);
    expect(retry.intentId).not.toBe(first.id);
    expect(await webhook(paidEvent({ ...(await intentOf(held.id)) }))).toBe('confirmed');
  });

  it('opens only one checkout when Pay is pressed twice at once', async () => {
    const { player, held } = await payable();
    const results = await Promise.allSettled([intents.startPayment(player.row.id, held.id), intents.startPayment(player.row.id, held.id)]);
    expect(await prisma.paymentIntent.count({ where: { bookingId: held.id } })).toBe(1);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) if (r.status === 'rejected') expect(code(r.reason)).toBe('PAYMENT_IN_PROGRESS');
  });

  it('does not let somebody else pay for or read another player\'s booking', async () => {
    const { held } = await payable();
    const stranger = await makeUser('stranger');
    await expect(intents.startPayment(stranger.row.id, held.id)).rejects.toMatchObject({ status: 403 });
    await expect(intents.statusFor(stranger.row.id, held.id)).rejects.toMatchObject({ status: 403 });
  });

  it('marks the intent failed and keeps the hold when the provider is down', async () => {
    const { player, held } = await payable();
    gateway.failCheckout = true;
    await expect(intents.startPayment(player.row.id, held.id)).rejects.toMatchObject({ response: { code: 'PAYMENT_GATEWAY_ERROR' } });
    expect((await intentOf(held.id)).status).toBe('failed');
    expect((await fresh(held.id)).status).toBe('held');
    gateway.failCheckout = false;
    expect((await intents.startPayment(player.row.id, held.id)).status).toBe('pending');
  });

  it('honours a payment that lands just after the hold lapsed when the time is still free', async () => {
    const { player, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    await prisma.booking.update({ where: { id: held.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    // the sweep gives the slot back
    await bookings.releaseUnpaidHold(held.id);
    expect((await fresh(held.id)).status).toBe('cancelled');
    expect(await webhook(paidEvent(await intentOf(held.id)))).toBe('revived');
    expect(await fresh(held.id)).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
  });

  it('refunds a payment that lands after somebody else took the time', async () => {
    const { player, court, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    await prisma.booking.update({ where: { id: held.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    await bookings.releaseUnpaidHold(held.id);
    const rival = await makeUser('rival');
    const taken = await hold(rival.row.id, court.id, held.slotStart);
    expect(taken.status).toBe('held');

    const intent = await intentOf(held.id);
    expect(await webhook(paidEvent(intent))).toBe('slot_lost');
    expect((await fresh(held.id)).status).toBe('cancelled');
    expect((await fresh(taken.id)).status).toBe('held');
    const after = await intentOf(held.id);
    expect(after.status).toBe('refunded');
    expect(after.refundedAmount).toBe(held.totalAmount);
    expect(gateway.refunds).toHaveLength(1);
    expect(gateway.refunds[0]).toMatchObject({ amount: held.totalAmount, idempotencyKey: `refund:${intent.id}` });
    expect(await prisma.notification.count({ where: { dedupKey: `payment-refund-due:${intent.id}` } })).toBe(1);
    expect(await prisma.notification.count({ where: { dedupKey: `payment-refunded:${intent.id}` } })).toBe(1);
    // the booking was never counted as income
    expect(await prisma.payment.count({ where: { bookingId: held.id } })).toBe(0);
  });

  it('keeps the refund owed when the provider is down, and the reconciler finishes it', async () => {
    const { player, court, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    await prisma.booking.update({ where: { id: held.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    await bookings.releaseUnpaidHold(held.id);
    await hold((await makeUser('rival')).row.id, court.id, held.slotStart);
    gateway.failRefund = true;
    const intent = await intentOf(held.id);
    expect(await webhook(paidEvent(intent))).toBe('slot_lost');
    expect(await intentOf(held.id)).toMatchObject({ status: 'refund_pending', refundDueAmount: held.totalAmount });
    gateway.failRefund = false;
    const stats = await reconciler.reconcile();
    expect(stats.refunds).toBeGreaterThanOrEqual(1);
    expect(await intentOf(held.id)).toMatchObject({ status: 'refunded', refundDueAmount: 0, refundedAmount: held.totalAmount });
  });

  it('does not revive a booking the player cancelled; the payment is refunded', async () => {
    const { player, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    await bookings.cancel(player.row.id, held.id);
    expect((await intentOf(held.id)).status).toBe('cancelled');
    expect(await webhook(paidEvent(await intentOf(held.id)))).toBe('slot_lost');
    expect((await fresh(held.id)).status).toBe('cancelled');
    expect((await intentOf(held.id)).status).toBe('refunded');
  });

  it('refunds a cancelled paid booking to the card through the gateway', async () => {
    const { player, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    await webhook(paidEvent(await intentOf(held.id)));
    await bookings.cancel(player.row.id, held.id, 'changed plans');
    const intent = await intentOf(held.id);
    expect(intent.status).toBe('refunded');
    expect(gateway.refunds).toHaveLength(1);
    const rows = await prisma.payment.findMany({ where: { bookingId: held.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.amount)).toEqual([held.totalAmount, -held.totalAmount]);
    expect(rows[1].providerRef).toMatch(/^gwr:testpay:/);
  });

  it('queues the refund when the provider is down at cancel time and finishes it later', async () => {
    const { player, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    await webhook(paidEvent(await intentOf(held.id)));
    gateway.failRefund = true;
    await bookings.cancel(player.row.id, held.id);
    expect((await fresh(held.id)).status).toBe('cancelled');
    expect(await intentOf(held.id)).toMatchObject({ status: 'refund_pending', refundDueAmount: held.totalAmount });
    gateway.failRefund = false;
    await reconciler.reconcile();
    expect((await intentOf(held.id)).status).toBe('refunded');
    expect(await prisma.payment.count({ where: { bookingId: held.id, amount: { lt: 0 } } })).toBe(1);
  });

  it('finds a payment whose notification never arrived (reconciler and status read)', async () => {
    const { player, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    const intent = await intentOf(held.id);
    gateway.statuses.set(intent.id, paidEvent(intent));
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { createdAt: new Date(Date.now() - 5 * 60_000), updatedAt: new Date(Date.now() - 5 * 60_000) } });
    await reconciler.reconcile();
    expect(await fresh(held.id)).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });

    const second = await payable(2);
    await intents.startPayment(second.player.row.id, second.held.id);
    const i2 = await intentOf(second.held.id);
    gateway.statuses.set(i2.id, paidEvent(i2));
    await prisma.paymentIntent.update({ where: { id: i2.id }, data: { updatedAt: new Date(Date.now() - 60_000) } });
    const status = await intents.statusFor(second.player.row.id, second.held.id);
    expect(status.booking.status).toBe('confirmed');
    expect(status.intent?.status).toBe('paid');
  });

  it('expires abandoned checkouts after the grace period', async () => {
    const { player, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    const intent = await intentOf(held.id);
    const old = new Date(Date.now() - 60 * 60_000);
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { createdAt: old, expiresAt: old } });
    await reconciler.reconcile();
    expect((await intentOf(held.id)).status).toBe('expired');
  });

  it('rejects notifications with a bad signature and unknown providers', async () => {
    const controller = new PaymentsController(intents, gateway);
    gateway.live = true;
    await expect(controller.webhook('testpay', { sig: 'forged', event: {} }, {}, {})).rejects.toMatchObject({ status: 401 });
    await expect(controller.webhook('stripe', {}, {}, {})).rejects.toMatchObject({ status: 404 });
    const { player, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    const intent = await intentOf(held.id);
    expect(await controller.webhook('testpay', { sig: 'valid', event: paidEvent(intent) }, {}, {})).toEqual({ received: true, outcome: 'confirmed' });
    expect((await fresh(held.id)).status).toBe('confirmed');
  });

  it('survives concurrent deliveries of the same notification', async () => {
    const { player, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    const intent = await intentOf(held.id);
    const results = await Promise.all([webhook(paidEvent(intent)), webhook(paidEvent(intent)), webhook(paidEvent(intent))]);
    expect(results.filter((r) => r === 'confirmed')).toHaveLength(1);
    expect(await prisma.payment.count({ where: { bookingId: held.id } })).toBe(1);
  });

  it('refunds a second, different payment for an already paid booking', async () => {
    const { player, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    const intent = await intentOf(held.id);
    await webhook(paidEvent(intent));
    const outcome = await webhook(paidEvent(intent, { eventId: 'dup-pay', providerPaymentRef: 'second-payment' }));
    expect(outcome).toBe('duplicate_payment');
    const clone = await prisma.paymentIntent.findFirstOrThrow({ where: { bookingId: held.id, providerPaymentRef: 'second-payment' } });
    expect(clone.status).toBe('refunded');
    expect(gateway.refunds.map((r) => r.providerPaymentRef)).toContain('second-payment');
    expect((await fresh(held.id)).status).toBe('confirmed');
  });

  it('lists payments that need a person', async () => {
    const { player, held } = await payable();
    await intents.startPayment(player.row.id, held.id);
    const intent = await intentOf(held.id);
    await webhook(paidEvent(intent, { amount: intent.amount + 5 }));
    const list = await intents.needingAttention();
    expect(list.find((i) => i.id === intent.id)).toMatchObject({ status: 'needs_review', failureCode: 'AMOUNT_MISMATCH' });
  });

  it('hides the venue the moment it is hidden: a hold cannot be paid', async () => {
    const { player, held, venue } = await payable();
    await prisma.venue.update({ where: { id: venue.id }, data: { adminHidden: true } });
    await expect(intents.startPayment(player.row.id, held.id)).rejects.toBeDefined();
    expect((await fresh(held.id)).status).toBe('cancelled');
  });
});
