-- Lobby Morphs: permanent per-user morph ownership, equipped-morph profile and
-- an append-only roll log (quota windows, analytics, idempotency).
-- Additive only: new enums, new tables, new indexes, FKs that cascade with the
-- owning User (guest sweep / orphan-guest delete keep working).

-- CreateEnum
CREATE TYPE "MorphTier" AS ENUM ('COMMON', 'EPIC', 'MISK');

-- CreateEnum
CREATE TYPE "MorphSource" AS ENUM ('DEFAULT', 'ROLL', 'GRANT', 'PURCHASE', 'SUBSCRIPTION', 'EVENT');

-- CreateTable
CREATE TABLE "UserMorph" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "morphId" TEXT NOT NULL,
    "source" "MorphSource" NOT NULL,
    "timesObtained" INTEGER NOT NULL DEFAULT 1,
    "firstObtainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObtainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seenAt" TIMESTAMP(3),

    CONSTRAINT "UserMorph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMorphProfile" (
    "userId" TEXT NOT NULL,
    "equippedMorphId" TEXT NOT NULL DEFAULT 'classic',
    "totalRolls" INTEGER NOT NULL DEFAULT 0,
    "rollsSinceEpicOrBetter" INTEGER NOT NULL DEFAULT 0,
    "rollsSinceMisk" INTEGER NOT NULL DEFAULT 0,
    "lastRollAt" TIMESTAMP(3),
    "bonusRolls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMorphProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "MorphRoll" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "morphId" TEXT NOT NULL,
    "tier" "MorphTier" NOT NULL,
    "wasNew" BOOLEAN NOT NULL,
    "pityApplied" "MorphTier",
    "quotaKind" TEXT NOT NULL DEFAULT 'FREE',
    "clientRollId" TEXT,
    "squadId" TEXT,
    "catalogVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MorphRoll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserMorph_userId_firstObtainedAt_idx" ON "UserMorph"("userId", "firstObtainedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserMorph_userId_morphId_key" ON "UserMorph"("userId", "morphId");

-- CreateIndex
CREATE INDEX "MorphRoll_userId_createdAt_idx" ON "MorphRoll"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MorphRoll_createdAt_idx" ON "MorphRoll"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MorphRoll_userId_clientRollId_key" ON "MorphRoll"("userId", "clientRollId");

-- AddForeignKey
ALTER TABLE "UserMorph" ADD CONSTRAINT "UserMorph_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMorphProfile" ADD CONSTRAINT "UserMorphProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MorphRoll" ADD CONSTRAINT "MorphRoll_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
