-- A price window cannot cross midnight: the engine compares clock times inside one day, so a rule
-- such as 17:00 → 02:00 (or 17:00 → 00:00) never matched any slot and left the evening "unpriced".
-- Split every such rule into "start → 24:00" plus, when it ran past midnight, "00:00 → end".
INSERT INTO "PricingRule" (
  "id", "courtId", "label", "daysOfWeek", "startTime", "endTime", "priceAmount", "currency",
  "priority", "kind", "source", "validFrom", "validUntil"
)
SELECT
  gen_random_uuid()::text, "courtId", "label" || '-late', "daysOfWeek", '00:00', "endTime", "priceAmount",
  "currency", "priority", "kind", "source", "validFrom", "validUntil"
FROM "PricingRule"
WHERE "endTime" < "startTime" AND "endTime" <> '00:00';

UPDATE "PricingRule"
SET "endTime" = '24:00'
WHERE "endTime" <= "startTime";
