-- Rewards risk controls: delayed trust, venue freeze, venue coin budget, device links.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "trustCandidateAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "trustBookingId" TEXT,
  ADD COLUMN IF NOT EXISTS "trustVenueId" TEXT,
  ADD COLUMN IF NOT EXISTS "rewardsBlockedAt" TIMESTAMP(3);

ALTER TABLE "Venue" ADD COLUMN IF NOT EXISTS "rewardsFrozenAt" TIMESTAMP(3);

ALTER TABLE "CoinGrant"
  ADD COLUMN IF NOT EXISTS "venueId" TEXT,
  ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'engagement';
CREATE INDEX IF NOT EXISTS "CoinGrant_venueId_category_status_paidAt_idx"
  ON "CoinGrant"("venueId", "category", "status", "paidAt");

CREATE INDEX IF NOT EXISTS "User_trustVenueId_trustCandidateAt_idx"
  ON "User"("trustVenueId", "trustCandidateAt");

CREATE TABLE IF NOT EXISTS "UserDevice" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deviceHash" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserDevice_userId_deviceHash_key" ON "UserDevice"("userId", "deviceHash");
CREATE INDEX IF NOT EXISTS "UserDevice_deviceHash_idx" ON "UserDevice"("deviceHash");
ALTER TABLE "UserDevice" ADD CONSTRAINT "UserDevice_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
