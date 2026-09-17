-- Align existing geo catalog tables with the Prisma models used by the public
-- country, governorate, district, and nearby-search endpoints. Older databases
-- were created before slugs and map geometry were added to the schema.
ALTER TABLE "Governorate"
  ADD COLUMN IF NOT EXISTS "slug" TEXT;

ALTER TABLE "District"
  ADD COLUMN IF NOT EXISTS "slug" TEXT,
  ADD COLUMN IF NOT EXISTS "lat" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "lng" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "polygon" JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS "Governorate_countryCode_slug_key"
  ON "Governorate"("countryCode", "slug");

CREATE UNIQUE INDEX IF NOT EXISTS "District_governorateId_slug_key"
  ON "District"("governorateId", "slug");
