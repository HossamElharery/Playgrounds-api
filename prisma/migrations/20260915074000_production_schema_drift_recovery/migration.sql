-- Recover schema objects that existed in Prisma's data model but were never
-- represented by a migration in older production databases.
--
-- This migration intentionally preserves Booking.slotRange. That generated
-- range column backs the live-booking exclusion constraint and must not be
-- removed even though Prisma cannot represent it in schema.prisma.

-- Payment methods used by the current checkout/wallet code.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'vodafone';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'orange';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'etisalat';

-- Columns read by public content, authentication, presence, chat, and teams.
ALTER TABLE "BlogPost"
  ADD COLUMN IF NOT EXISTS "ctaHref" TEXT,
  ADD COLUMN IF NOT EXISTS "ctaLabelAr" TEXT,
  ADD COLUMN IF NOT EXISTS "ctaLabelEn" TEXT,
  ADD COLUMN IF NOT EXISTS "relatedSportSlug" TEXT;

ALTER TABLE "ChatMessage"
  ADD COLUMN IF NOT EXISTS "attachmentDurationMs" INTEGER;

ALTER TABLE "ChatThread"
  ADD COLUMN IF NOT EXISTS "title" TEXT;

ALTER TABLE "Team"
  ADD COLUMN IF NOT EXISTS "chatThreadId" TEXT,
  ADD COLUMN IF NOT EXISTS "sportId" TEXT;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "bioAr" TEXT,
  ADD COLUMN IF NOT EXISTS "bioEn" TEXT,
  ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastSeenVisible" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "matchesPlayed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "messagePolicy" TEXT NOT NULL DEFAULT 'everyone',
  ADD COLUMN IF NOT EXISTS "mvps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "notificationPrefs" JSONB;

ALTER TABLE "CountryConfig" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "PageSeoOverride" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "Venue" ALTER COLUMN "countryCode" SET DEFAULT 'EG';

-- Device registrations, social privacy, favourites, and feed interactions.
CREATE TABLE IF NOT EXISTS "DeviceToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "platform" TEXT NOT NULL DEFAULT 'web',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "UserBlock" (
  "id" TEXT NOT NULL,
  "blockerId" TEXT NOT NULL,
  "blockedId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FavoriteVenue" (
  "userId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FavoriteVenue_pkey" PRIMARY KEY ("userId", "venueId")
);

CREATE TABLE IF NOT EXISTS "MatchPostComment" (
  "id" TEXT NOT NULL,
  "matchPostId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "MatchPostComment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MatchPostReaction" (
  "id" TEXT NOT NULL,
  "matchPostId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "emoji" TEXT NOT NULL DEFAULT 'like',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MatchPostReaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeviceToken_userId_idx"
  ON "DeviceToken"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "DeviceToken_userId_token_key"
  ON "DeviceToken"("userId", "token");
CREATE INDEX IF NOT EXISTS "UserBlock_blockedId_idx"
  ON "UserBlock"("blockedId");
CREATE UNIQUE INDEX IF NOT EXISTS "UserBlock_blockerId_blockedId_key"
  ON "UserBlock"("blockerId", "blockedId");
CREATE INDEX IF NOT EXISTS "MatchPostComment_matchPostId_createdAt_idx"
  ON "MatchPostComment"("matchPostId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "MatchPostReaction_matchPostId_userId_emoji_key"
  ON "MatchPostReaction"("matchPostId", "userId", "emoji");
CREATE INDEX IF NOT EXISTS "BlogPost_relatedSportSlug_idx"
  ON "BlogPost"("relatedSportSlug");
CREATE UNIQUE INDEX IF NOT EXISTS "Team_chatThreadId_key"
  ON "Team"("chatThreadId");

-- Add constraints only when absent so recovery remains safe if an older
-- environment was partially aligned by hand.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeviceToken_userId_fkey') THEN
    ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserBlock_blockerId_fkey') THEN
    ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockerId_fkey"
      FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserBlock_blockedId_fkey') THEN
    ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockedId_fkey"
      FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FavoriteVenue_userId_fkey') THEN
    ALTER TABLE "FavoriteVenue" ADD CONSTRAINT "FavoriteVenue_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FavoriteVenue_venueId_fkey') THEN
    ALTER TABLE "FavoriteVenue" ADD CONSTRAINT "FavoriteVenue_venueId_fkey"
      FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MatchPostComment_matchPostId_fkey') THEN
    ALTER TABLE "MatchPostComment" ADD CONSTRAINT "MatchPostComment_matchPostId_fkey"
      FOREIGN KEY ("matchPostId") REFERENCES "MatchPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MatchPostComment_authorId_fkey') THEN
    ALTER TABLE "MatchPostComment" ADD CONSTRAINT "MatchPostComment_authorId_fkey"
      FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MatchPostReaction_matchPostId_fkey') THEN
    ALTER TABLE "MatchPostReaction" ADD CONSTRAINT "MatchPostReaction_matchPostId_fkey"
      FOREIGN KEY ("matchPostId") REFERENCES "MatchPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MatchPostReaction_userId_fkey') THEN
    ALTER TABLE "MatchPostReaction" ADD CONSTRAINT "MatchPostReaction_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Team_sportId_fkey') THEN
    ALTER TABLE "Team" ADD CONSTRAINT "Team_sportId_fkey"
      FOREIGN KEY ("sportId") REFERENCES "SportCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Team_chatThreadId_fkey') THEN
    ALTER TABLE "Team" ADD CONSTRAINT "Team_chatThreadId_fkey"
      FOREIGN KEY ("chatThreadId") REFERENCES "ChatThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Align the nullable booking relation without touching booking or rating data.
ALTER TABLE "PlayerRating" DROP CONSTRAINT IF EXISTS "PlayerRating_bookingId_fkey";
ALTER TABLE "PlayerRating" ADD CONSTRAINT "PlayerRating_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
