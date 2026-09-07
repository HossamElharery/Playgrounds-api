-- Global country model, denormalized search fields, and scale indexes.
-- Adding a market = CountryConfig row + geo seed. No application rewrite.

ALTER TABLE "CountryConfig"
  ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo',
  ADD COLUMN IF NOT EXISTS "locale" TEXT NOT NULL DEFAULT 'ar',
  ADD COLUMN IF NOT EXISTS "serviceFeePct" DOUBLE PRECISION NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "coinsPerHundredMajor" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "coinToMajorRate" DOUBLE PRECISION NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS "lat" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "lng" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;

INSERT INTO "CountryConfig" (
  "code", "nameEn", "nameAr", "currency", "phoneCallingCode",
  "timezone", "locale", "weekendDays", "paymentMethods",
  "serviceFeePct", "coinsPerHundredMajor", "coinToMajorRate",
  "lat", "lng", "active"
) VALUES (
  'EG', 'Egypt', E'مصر', 'EGP', '+20',
  'Africa/Cairo', 'ar', ARRAY[5, 6],
  ARRAY['card','wallet','vodafone','orange','etisalat','fawry','instapay','cash'],
  5, 10, 20, 30.0444, 31.2357, true
) ON CONFLICT ("code") DO UPDATE SET
  "timezone" = EXCLUDED."timezone",
  "locale" = EXCLUDED."locale",
  "lat" = EXCLUDED."lat",
  "lng" = EXCLUDED."lng";

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "countryCode" TEXT NOT NULL DEFAULT 'EG';

UPDATE "User" SET "countryCode" = 'EG' WHERE "countryCode" IS NULL OR "countryCode" = '';

DO $$ BEGIN
  ALTER TABLE "User"
    ADD CONSTRAINT "User_countryCode_fkey"
    FOREIGN KEY ("countryCode") REFERENCES "CountryConfig"("code")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "User_countryCode_idx" ON "User"("countryCode");

ALTER TABLE "Venue"
  ADD COLUMN IF NOT EXISTS "countryCode" TEXT,
  ADD COLUMN IF NOT EXISTS "priceFromAmount" INTEGER,
  ADD COLUMN IF NOT EXISTS "priceFromCurrency" TEXT;

UPDATE "Venue" v
SET "countryCode" = g."countryCode"
FROM "Governorate" g
WHERE v."governorateId" = g."id" AND v."countryCode" IS NULL;

UPDATE "Venue" SET "countryCode" = 'EG' WHERE "countryCode" IS NULL;

ALTER TABLE "Venue" ALTER COLUMN "countryCode" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "Venue"
    ADD CONSTRAINT "Venue_countryCode_fkey"
    FOREIGN KEY ("countryCode") REFERENCES "CountryConfig"("code")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

UPDATE "Venue" v
SET
  "priceFromAmount" = sub.min_price,
  "priceFromCurrency" = sub.currency
FROM (
  SELECT c."venueId", MIN(p."priceAmount") AS min_price, MIN(p.currency) AS currency
  FROM "Court" c
  JOIN "PricingRule" p ON p."courtId" = c.id
  GROUP BY c."venueId"
) sub
WHERE v.id = sub."venueId";

CREATE INDEX IF NOT EXISTS "Venue_countryCode_status_idx" ON "Venue"("countryCode", "status");
CREATE INDEX IF NOT EXISTS "Venue_status_districtId_idx" ON "Venue"("status", "districtId");
CREATE INDEX IF NOT EXISTS "Venue_status_governorateId_idx" ON "Venue"("status", "governorateId");
CREATE INDEX IF NOT EXISTS "Venue_status_geohash_idx" ON "Venue"("status", "geohash");
CREATE INDEX IF NOT EXISTS "Venue_status_ratingAvg_idx" ON "Venue"("status", "ratingAvg");

CREATE INDEX IF NOT EXISTS "Booking_venueId_slotStart_idx" ON "Booking"("venueId", "slotStart");
CREATE INDEX IF NOT EXISTS "Booking_venueId_status_idx" ON "Booking"("venueId", "status");
CREATE INDEX IF NOT EXISTS "MatchPost_dateTime_status_idx" ON "MatchPost"("dateTime", "status");
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'apple_pay';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'google_pay';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'paypal';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'mada';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'stc_pay';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'benefit';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'knet';
