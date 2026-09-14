-- Stops a rater from rating the same person on the same booking/match more
-- than once — previously unbounded, and each rating paid the rater 10 coins,
-- so this was a free coin-farming loop.
--
-- Older production databases were created before match-post ratings were
-- added to the Prisma schema. Bring that table shape up to date before using
-- matchPostId below. Every statement is safe to retry after a failed deploy.
ALTER TABLE "PlayerRating" ADD COLUMN IF NOT EXISTS "matchPostId" TEXT;
ALTER TABLE "PlayerRating" ALTER COLUMN "bookingId" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PlayerRating_matchPostId_fkey'
  ) THEN
    ALTER TABLE "PlayerRating"
      ADD CONSTRAINT "PlayerRating_matchPostId_fkey"
      FOREIGN KEY ("matchPostId") REFERENCES "MatchPost"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DROP INDEX IF EXISTS "PlayerRating_bookingId_raterId_rateeId_idx";
DROP INDEX IF EXISTS "PlayerRating_matchPostId_raterId_rateeId_idx";

-- Keep the earliest rating if legacy data already contains duplicates. Without
-- this cleanup, CREATE UNIQUE INDEX aborts the entire production migration.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "bookingId", "raterId", "rateeId"
    ORDER BY "createdAt", "id"
  ) AS row_number
  FROM "PlayerRating"
  WHERE "bookingId" IS NOT NULL
)
DELETE FROM "PlayerRating"
USING ranked
WHERE "PlayerRating"."id" = ranked."id" AND ranked.row_number > 1;

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "matchPostId", "raterId", "rateeId"
    ORDER BY "createdAt", "id"
  ) AS row_number
  FROM "PlayerRating"
  WHERE "matchPostId" IS NOT NULL
)
DELETE FROM "PlayerRating"
USING ranked
WHERE "PlayerRating"."id" = ranked."id" AND ranked.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "PlayerRating_bookingId_raterId_rateeId_key" ON "PlayerRating"("bookingId", "raterId", "rateeId");
CREATE UNIQUE INDEX IF NOT EXISTS "PlayerRating_matchPostId_raterId_rateeId_key" ON "PlayerRating"("matchPostId", "raterId", "rateeId");
