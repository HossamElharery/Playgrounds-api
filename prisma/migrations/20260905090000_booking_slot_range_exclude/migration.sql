-- btree_gist enables EXCLUDE … WITH = on scalar columns alongside range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- tstzrange() is STABLE, so it cannot appear in an index expression.
-- Keep a trigger-maintained range column and exclude on that column instead.
ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "slotRange" tstzrange;

UPDATE "Booking"
SET "slotRange" = tstzrange("slotStart", "slotEnd", '[)')
WHERE "slotRange" IS NULL;

ALTER TABLE "Booking"
  ALTER COLUMN "slotRange" SET NOT NULL;

CREATE OR REPLACE FUNCTION booking_set_slot_range()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."slotRange" := tstzrange(NEW."slotStart", NEW."slotEnd", '[)');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS booking_slot_range_tg ON "Booking";
CREATE TRIGGER booking_slot_range_tg
BEFORE INSERT OR UPDATE OF "slotStart", "slotEnd"
ON "Booking"
FOR EACH ROW
EXECUTE FUNCTION booking_set_slot_range();

-- A court cannot have two live bookings whose [slotStart, slotEnd) ranges overlap.
-- Stronger than Booking_court_slot_live_unique, which only keyed slotStart and
-- missed multi-unit / walk-in windows that start at a different instant.
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_court_slot_range_excl";

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_court_slot_range_excl"
  EXCLUDE USING gist (
    "courtId" WITH =,
    "slotRange" WITH &&
  )
  WHERE ("status" IN ('held', 'confirmed'));
