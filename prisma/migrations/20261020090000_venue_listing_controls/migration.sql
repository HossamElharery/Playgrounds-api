-- Separate the owner's wishes from the platform's moderation decision.
--   status               admin approval / suspension (unchanged)
--   ownerListingEnabled  owner wants the venue listed on Matchena
--   adminHidden          platform-forced unlisting the owner cannot lift
--   instantBook          booking acceptance (existing column, now an owner switch)
--   operationsEnabled    owner operations system switch
-- Every column is additive with a default that keeps today's behaviour, so the
-- previous backend build keeps working against the migrated schema.
ALTER TABLE "Venue"
  ADD COLUMN IF NOT EXISTS "ownerListingEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "adminHidden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "operationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "moderationReason" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "moderatedById" TEXT,
  ADD COLUMN IF NOT EXISTS "moderatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "listingChangedById" TEXT,
  ADD COLUMN IF NOT EXISTS "listingChangedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Venue_status_ownerListingEnabled_adminHidden_idx"
  ON "Venue" ("status", "ownerListingEnabled", "adminHidden");

-- Backfill the "who/why" of venues that are already suspended so the admin
-- screen has something truthful to show.
UPDATE "Venue" SET "moderatedAt" = "updatedAt"
WHERE "status" = 'suspended' AND "moderatedAt" IS NULL;
