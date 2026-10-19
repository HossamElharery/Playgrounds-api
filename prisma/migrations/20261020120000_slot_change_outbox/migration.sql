-- Live availability for players. Every change that can alter what a player may
-- book (a booking or hold appearing, being confirmed, cancelled, expired or
-- deleted; a calendar block; a venue being hidden, suspended or paused) writes a
-- tiny row here from a trigger. Each backend instance reads new rows and pushes
-- them to the sockets watching that venue. Triggers, not application code, so no
-- code path (player, owner, admin, cron, import) can forget to announce a change.
CREATE TABLE IF NOT EXISTS "SlotChange" (
  "id"        BIGSERIAL PRIMARY KEY,
  "venueId"   TEXT NOT NULL,
  "courtId"   TEXT,
  "startsAt"  TIMESTAMP(3),
  "endsAt"    TIMESTAMP(3),
  "kind"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "SlotChange_createdAt_idx" ON "SlotChange" ("createdAt");

CREATE OR REPLACE FUNCTION slot_change_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  live CONSTANT text[] := ARRAY['held', 'confirmed'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text = ANY (live) THEN
      INSERT INTO "SlotChange" ("venueId", "courtId", "startsAt", "endsAt", "kind")
      VALUES (NEW."venueId", NEW."courtId", NEW."slotStart", NEW."slotEnd", 'booking');
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."status"::text = ANY (live) THEN
      INSERT INTO "SlotChange" ("venueId", "courtId", "startsAt", "endsAt", "kind")
      VALUES (OLD."venueId", OLD."courtId", OLD."slotStart", OLD."slotEnd", 'booking');
    END IF;
    RETURN OLD;
  ELSE
    IF (OLD."status"::text = ANY (live) OR NEW."status"::text = ANY (live))
       AND (OLD."status" IS DISTINCT FROM NEW."status"
            OR OLD."slotStart" IS DISTINCT FROM NEW."slotStart"
            OR OLD."slotEnd" IS DISTINCT FROM NEW."slotEnd"
            OR OLD."courtId" IS DISTINCT FROM NEW."courtId") THEN
      INSERT INTO "SlotChange" ("venueId", "courtId", "startsAt", "endsAt", "kind")
      VALUES (NEW."venueId", NEW."courtId", LEAST(OLD."slotStart", NEW."slotStart"), GREATEST(OLD."slotEnd", NEW."slotEnd"), 'booking');
      IF OLD."courtId" IS DISTINCT FROM NEW."courtId" THEN
        INSERT INTO "SlotChange" ("venueId", "courtId", "startsAt", "endsAt", "kind")
        VALUES (OLD."venueId", OLD."courtId", OLD."slotStart", OLD."slotEnd", 'booking');
      END IF;
    END IF;
    RETURN NEW;
  END IF;
END $$;

DROP TRIGGER IF EXISTS "Booking_slot_change_tg" ON "Booking";
CREATE TRIGGER "Booking_slot_change_tg"
AFTER INSERT OR UPDATE OR DELETE ON "Booking"
FOR EACH ROW EXECUTE FUNCTION slot_change_booking();

CREATE OR REPLACE FUNCTION slot_change_block() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO "SlotChange" ("venueId", "courtId", "startsAt", "endsAt", "kind")
    VALUES (NEW."venueId", NEW."courtId", NEW."startsAt", NEW."endsAt", 'block');
  END IF;
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO "SlotChange" ("venueId", "courtId", "startsAt", "endsAt", "kind")
    VALUES (OLD."venueId", OLD."courtId", OLD."startsAt", OLD."endsAt", 'block');
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS "CalendarBlock_slot_change_tg" ON "CalendarBlock";
CREATE TRIGGER "CalendarBlock_slot_change_tg"
AFTER INSERT OR UPDATE OR DELETE ON "CalendarBlock"
FOR EACH ROW EXECUTE FUNCTION slot_change_block();

CREATE OR REPLACE FUNCTION slot_change_venue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "SlotChange" ("venueId", "courtId", "startsAt", "endsAt", "kind")
  VALUES (NEW."id", NULL, NULL, NULL, 'venue');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Venue_slot_change_tg" ON "Venue";
CREATE TRIGGER "Venue_slot_change_tg"
AFTER UPDATE OF "status", "ownerListingEnabled", "adminHidden", "instantBook", "weeklyHours" ON "Venue"
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status"
   OR OLD."ownerListingEnabled" IS DISTINCT FROM NEW."ownerListingEnabled"
   OR OLD."adminHidden" IS DISTINCT FROM NEW."adminHidden"
   OR OLD."instantBook" IS DISTINCT FROM NEW."instantBook"
   OR OLD."weeklyHours" IS DISTINCT FROM NEW."weeklyHours")
EXECUTE FUNCTION slot_change_venue();
