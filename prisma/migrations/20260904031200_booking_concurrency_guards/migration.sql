-- Enable trigram search for Arabic/English fuzzy matching (venue/player names).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The single most important correctness guarantee in the schema: a court
-- cannot have two live (held-or-confirmed) rows for the same slotStart at
-- the same time. `status` is a plain column (not a now()-based predicate,
-- which Postgres rejects for index predicates as non-immutable) — expired
-- holds are flipped out of ('held','confirmed') by the jobs module's cron
-- sweep, which is what actually releases the slot.
CREATE UNIQUE INDEX "Booking_court_slot_live_unique"
  ON "Booking" ("courtId", "slotStart")
  WHERE "status" IN ('held', 'confirmed');

-- Trigram indexes for name search.
CREATE INDEX "Venue_nameEn_trgm" ON "Venue" USING gin ("nameEn" gin_trgm_ops);
CREATE INDEX "Venue_nameAr_trgm" ON "Venue" USING gin ("nameAr" gin_trgm_ops);
CREATE INDEX "User_name_trgm" ON "User" USING gin ("name" gin_trgm_ops);
