-- Staff calls: owner <-> team voice calls. Additive only; nothing existing is touched.
CREATE TYPE "StaffCallStatus" AS ENUM ('ringing', 'answered', 'declined', 'missed', 'cancelled', 'busy', 'unavailable', 'failed', 'ended');

CREATE TABLE "StaffCall" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "callerId" TEXT NOT NULL,
  "calleeId" TEXT NOT NULL,
  "status" "StaffCallStatus" NOT NULL DEFAULT 'ringing',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answeredAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "endReason" TEXT,
  "seenAt" TIMESTAMP(3),
  CONSTRAINT "StaffCall_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StaffCall_callerId_createdAt_idx" ON "StaffCall"("callerId", "createdAt");
CREATE INDEX "StaffCall_calleeId_createdAt_idx" ON "StaffCall"("calleeId", "createdAt");
CREATE INDEX "StaffCall_ownerId_createdAt_idx" ON "StaffCall"("ownerId", "createdAt");
CREATE INDEX "StaffCall_status_createdAt_idx" ON "StaffCall"("status", "createdAt");

CREATE TABLE "CallMute" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "muterId" TEXT NOT NULL,
  "mutedId" TEXT NOT NULL,
  "until" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallMute_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CallMute_muterId_mutedId_key" ON "CallMute"("muterId", "mutedId");
CREATE INDEX "CallMute_muterId_until_idx" ON "CallMute"("muterId", "until");

CREATE TABLE "CallSettings" (
  "userId" TEXT NOT NULL,
  "dndUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CallSettings_pkey" PRIMARY KEY ("userId")
);
