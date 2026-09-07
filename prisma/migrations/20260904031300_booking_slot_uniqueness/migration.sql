-- The single most important correctness guarantee in the schema: a court
-- cannot have two live (held-or-confirmed) rows for the same slotStart at
-- the same time. This is a partial index (WHERE clause), which Prisma
-- cannot express declaratively in schema.prisma — it is intentionally NOT
-- mirrored there, so `prisma migrate dev` will never see it as drift and
-- try to drop it. An expired 'held' booking is flipped out of this set by
-- the jobs module's cron sweep, which is what actually releases the slot.
CREATE UNIQUE INDEX "Booking_court_slot_live_unique"
  ON "Booking" ("courtId", "slotStart")
  WHERE "status" IN ('held', 'confirmed');
