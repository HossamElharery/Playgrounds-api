-- Matchena Pro list price is 1,000 EGP (was 3,000). It is shown struck-through and marked
-- "Free" to the owner; the agreed price stays admin-only. Only untouched defaults are changed,
-- so any price an admin typed for a venue is kept.
ALTER TABLE "VenueSubscription" ALTER COLUMN "listPriceAmount" SET DEFAULT 100000;
UPDATE "VenueSubscription" SET "listPriceAmount" = 100000 WHERE "listPriceAmount" = 300000;
