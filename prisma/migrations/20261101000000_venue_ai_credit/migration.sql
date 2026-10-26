-- Venue AI credit: a per-venue monthly USD allowance for the owner assistant, shared by the owner
-- and every staff login, plus manual top-ups. Additive only.

ALTER TABLE "VenueSubscription"
  ADD COLUMN IF NOT EXISTS "aiAssistantEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "aiCreditOverrideUsd" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "aiTrial" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "aiCycleStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "aiCycleEndsAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "aiCycleSpentMicros" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "aiTopUpMicros" INTEGER NOT NULL DEFAULT 0;

-- From now on a venue is on the trial credit until an admin adds time. Venues that already exist
-- are past it when an admin added time to them or already approved them (grandfathered, so live
-- customers keep their plan's credit after this deploy). Venues still pending stay on the trial.
UPDATE "VenueSubscription" s
SET "aiTrial" = false
WHERE EXISTS (SELECT 1 FROM "SubscriptionPayment" p WHERE p."subscriptionId" = s."id")
   OR EXISTS (
     SELECT 1 FROM "AuditLogEntry" a
     WHERE a."action" = 'subscription.started' AND a."targetId" = s."venueId"
   )
   OR EXISTS (
     SELECT 1 FROM "Venue" v
     WHERE v."id" = s."venueId" AND (v."approvedAt" IS NOT NULL OR v."status" = 'active')
   );

CREATE TABLE IF NOT EXISTS "AiCreditTopUp" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "receivedAmount" INTEGER NOT NULL DEFAULT 0,
  "receivedCurrency" TEXT NOT NULL DEFAULT 'EGP',
  "creditedMicros" INTEGER NOT NULL,
  "note" TEXT,
  "recordedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiCreditTopUp_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AiCreditTopUp_venueId_createdAt_idx" ON "AiCreditTopUp"("venueId", "createdAt");
ALTER TABLE "AiCreditTopUp" ADD CONSTRAINT "AiCreditTopUp_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "VenueSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiCreditTopUp" ADD CONSTRAINT "AiCreditTopUp_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
