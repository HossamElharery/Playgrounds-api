-- Admin-set free trial length (days), used by /partners and as the venue approval default.
ALTER TABLE "PlatformSetting" ADD COLUMN "trialDays" INTEGER NOT NULL DEFAULT 15;

-- The old column default (1,000 EGP) predates per-plan, per-country prices.
ALTER TABLE "VenueSubscription" ALTER COLUMN "listPriceAmount" SET DEFAULT 200000;

-- Subscriptions made before prices were per country were all billed in EGP at the old
-- default. Move every subscription that has never been paid to its venue's currency and
-- its plan's catalog price there (0 where that currency has no public price yet).
WITH prices(currency, plan_key, amount) AS (
  VALUES
    ('EGP', 'starter', 100000), ('EGP', 'pro', 200000), ('EGP', 'business', 350000),
    ('EGP', 'gaming-lite', 30000), ('EGP', 'gaming-pro', 60000),
    ('SAR', 'starter', 7900), ('SAR', 'pro', 19900), ('SAR', 'business', 39900),
    ('SAR', 'gaming-lite', 3900), ('SAR', 'gaming-pro', 7900),
    ('AED', 'starter', 14900), ('AED', 'pro', 29900), ('AED', 'business', 59900),
    ('AED', 'gaming-lite', 5900), ('AED', 'gaming-pro', 11900)
)
UPDATE "VenueSubscription" s
SET "currency" = UPPER(v."currency"),
    "listPriceAmount" = COALESCE(p.amount, 0)
FROM "Venue" v
LEFT JOIN prices p ON p.currency = UPPER(v."currency")
WHERE v."id" = s."venueId"
  AND (p.plan_key IS NULL OR p.plan_key = s."planKey")
  AND NOT EXISTS (SELECT 1 FROM "SubscriptionPayment" sp WHERE sp."subscriptionId" = s."id" AND sp."amount" > 0)
  AND (s."currency" <> UPPER(v."currency") OR (p.amount IS NOT NULL AND s."listPriceAmount" <> p.amount));
