-- One player cannot hold or confirm two overlapping bookings, even when two
-- requests arrive concurrently for different courts or venues. slotRange and
-- btree_gist are installed by 20260905090000_booking_slot_range_exclude.
UPDATE "Booking"
SET "status" = 'cancelled', "holdExpiresAt" = NULL
WHERE "status" = 'held'
  AND "holdExpiresAt" IS NOT NULL
  AND "holdExpiresAt" < NOW();

ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_user_slot_range_excl";

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_user_slot_range_excl"
  EXCLUDE USING gist (
    "userId" WITH =,
    "slotRange" WITH &&
  )
  WHERE ("status" IN ('held', 'confirmed'));
