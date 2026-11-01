-- Matchena Hub: console power control (wake / rest mode) through a LAN agent, no smart plug needed.
CREATE TABLE "GamingHub" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT,
    "tokenHash" TEXT NOT NULL,
    "hostname" TEXT,
    "platform" TEXT,
    "hubVersion" TEXT,
    "psnLinked" BOOLEAN NOT NULL DEFAULT false,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GamingHub_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GamingHub_tokenHash_key" ON "GamingHub"("tokenHash");
CREATE INDEX "GamingHub_venueId_idx" ON "GamingHub"("venueId");
ALTER TABLE "GamingHub" ADD CONSTRAINT "GamingHub_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GamingHubClaim" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdBy" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GamingHubClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GamingHubClaim_codeHash_key" ON "GamingHubClaim"("codeHash");
CREATE INDEX "GamingHubClaim_venueId_idx" ON "GamingHubClaim"("venueId");
CREATE INDEX "GamingHubClaim_expiresAt_idx" ON "GamingHubClaim"("expiresAt");
ALTER TABLE "GamingHubClaim" ADD CONSTRAINT "GamingHubClaim_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GamingDevice" ADD COLUMN "hubId" TEXT,
ADD COLUMN "paired" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "address" TEXT,
ADD COLUMN "consoleState" TEXT;
CREATE INDEX "GamingDevice_hubId_idx" ON "GamingDevice"("hubId");
ALTER TABLE "GamingDevice" ADD CONSTRAINT "GamingDevice_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "GamingHub"("id") ON DELETE SET NULL ON UPDATE CASCADE;
