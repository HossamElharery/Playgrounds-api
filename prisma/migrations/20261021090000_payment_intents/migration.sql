-- Online card payment for a booking, provider-agnostic.
--   PaymentIntent        one attempt to pay a held booking; the amount is copied from the
--                        booking on the server, never taken from the client
--   PaymentWebhookEvent  every provider notification, unique per (provider, eventId), so a
--                        repeated or late delivery is recognised and does nothing twice
-- Nothing here is reachable until a live gateway is configured (PAYMENT_GATEWAY).
CREATE TYPE "PaymentIntentStatus" AS ENUM (
  'created', 'pending', 'paid', 'failed', 'expired', 'cancelled',
  'refund_pending', 'refunded', 'partially_refunded', 'needs_review'
);

CREATE TABLE "PaymentIntent" (
  "id"                 TEXT PRIMARY KEY,
  "bookingId"          TEXT NOT NULL REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "userId"             TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "provider"           TEXT NOT NULL,
  "status"             "PaymentIntentStatus" NOT NULL DEFAULT 'created',
  "amount"             INTEGER NOT NULL CHECK ("amount" > 0),
  "currency"           TEXT NOT NULL,
  "providerOrderRef"   TEXT,
  "providerPaymentRef" TEXT,
  "checkoutUrl"        TEXT,
  "failureCode"        TEXT,
  "refundedAmount"     INTEGER NOT NULL DEFAULT 0 CHECK ("refundedAmount" >= 0),
  "refundDueAmount"    INTEGER NOT NULL DEFAULT 0 CHECK ("refundDueAmount" >= 0),
  "expiresAt"          TIMESTAMP(3) NOT NULL,
  "paidAt"             TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PaymentIntent_bookingId_idx" ON "PaymentIntent" ("bookingId");
CREATE INDEX "PaymentIntent_status_expiresAt_idx" ON "PaymentIntent" ("status", "expiresAt");
-- A provider transaction or order can belong to one intent only.
CREATE UNIQUE INDEX "PaymentIntent_provider_payment_ref_key"
  ON "PaymentIntent" ("provider", "providerPaymentRef") WHERE "providerPaymentRef" IS NOT NULL;
CREATE UNIQUE INDEX "PaymentIntent_provider_order_ref_key"
  ON "PaymentIntent" ("provider", "providerOrderRef") WHERE "providerOrderRef" IS NOT NULL;
-- At most one open attempt per booking: a double tap on "Pay" cannot start two checkouts.
CREATE UNIQUE INDEX "PaymentIntent_one_open_per_booking"
  ON "PaymentIntent" ("bookingId") WHERE "status" IN ('created', 'pending');

CREATE TABLE "PaymentWebhookEvent" (
  "id"          TEXT PRIMARY KEY,
  "provider"    TEXT NOT NULL,
  "eventId"     TEXT NOT NULL,
  "intentId"    TEXT,
  "status"      TEXT NOT NULL,
  "outcome"     TEXT,
  "receivedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_eventId_key" ON "PaymentWebhookEvent" ("provider", "eventId");
CREATE INDEX "PaymentWebhookEvent_intentId_idx" ON "PaymentWebhookEvent" ("intentId");

-- Gateway money movements carry a namespaced reference ("gw:<provider>:<id>" for a charge,
-- "gwr:<provider>:<id>" for a refund) that may exist once. Other rows (cash, wallet) are untouched.
CREATE UNIQUE INDEX "Payment_gateway_ref_unique"
  ON "Payment" ("providerRef") WHERE "providerRef" LIKE 'gw:%' OR "providerRef" LIKE 'gwr:%';
