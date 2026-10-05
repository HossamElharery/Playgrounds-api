ALTER TABLE "Booking" ADD COLUMN "manualRequestKey" TEXT;
ALTER TABLE "Booking" ADD COLUMN "manualRequestHash" TEXT;
CREATE UNIQUE INDEX "Booking_manualRequestKey_key" ON "Booking"("manualRequestKey");
CREATE TABLE "OwnerOfflineGrant" (
  "id" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "cashAllowed" BOOLEAN NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL, "replayUntil" TIMESTAMP(3) NOT NULL,
  "horizonEnd" TIMESTAMP(3) NOT NULL, CONSTRAINT "OwnerOfflineGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OwnerOfflineGrant_tokenHash_key" ON "OwnerOfflineGrant"("tokenHash");
CREATE INDEX "OwnerOfflineGrant_userId_venueId_idx" ON "OwnerOfflineGrant"("userId", "venueId");
