-- Stops a rater from rating the same person on the same booking/match more
-- than once — previously unbounded, and each rating paid the rater 10 coins,
-- so this was a free coin-farming loop.
DROP INDEX IF EXISTS "PlayerRating_bookingId_raterId_rateeId_idx";
DROP INDEX IF EXISTS "PlayerRating_matchPostId_raterId_rateeId_idx";
CREATE UNIQUE INDEX "PlayerRating_bookingId_raterId_rateeId_key" ON "PlayerRating"("bookingId", "raterId", "rateeId");
CREATE UNIQUE INDEX "PlayerRating_matchPostId_raterId_rateeId_key" ON "PlayerRating"("matchPostId", "raterId", "rateeId");
