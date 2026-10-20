-- Booking_user_slot_range_excl stops one player holding two places at once.
-- Manual bookings (walk-ins, phone bookings, fixed series, imports) are stored
-- under the owner or staff member who recorded them, so the same constraint
-- refused a second walk-in on another court at the same hour, or one that
-- overlapped the owner's own player booking elsewhere, as SLOT_ALREADY_HELD
-- while the board correctly showed the court free. Scope it to platform
-- bookings, where userId really is the player.
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_user_slot_range_excl";

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_user_slot_range_excl"
  EXCLUDE USING gist (
    "userId" WITH =,
    "slotRange" WITH &&
  )
  WHERE ("status" IN ('held', 'confirmed') AND "source" = 'platform');
