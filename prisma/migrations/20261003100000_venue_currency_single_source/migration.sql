-- One currency per venue, taken from its country. Until now the venue's currency was guessed
-- from the first pricing rule (`priceFromCurrency ?? 'EGP'`) and manual bookings fell back to
-- the column default (EGP), so an AED venue could hold EGP bookings.
ALTER TABLE "Venue" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'EGP';

UPDATE "Venue" v
SET "currency" = c."currency"
FROM "CountryConfig" c
WHERE c."code" = v."countryCode";

-- Manual bookings are priced by the owner in the venue's own price list, so a different
-- currency on them is the bug, not the data: relabel the booking and its payments.
UPDATE "Payment" p
SET "currency" = v."currency"
FROM "Booking" b, "Venue" v
WHERE p."bookingId" = b."id" AND v."id" = b."venueId"
  AND b."source" = 'manual' AND p."currency" <> v."currency";

UPDATE "Booking" b
SET "currency" = v."currency"
FROM "Venue" v
WHERE v."id" = b."venueId" AND b."source" = 'manual' AND b."currency" <> v."currency";
