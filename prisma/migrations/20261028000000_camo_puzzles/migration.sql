-- Camo game: link challenges and the daily Chameleon (hand-written; applied to the scratch database only).
ALTER TABLE "CamoStats" ADD COLUMN "dailyStreak" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "lastDailyDay" TEXT;

CREATE TABLE "CamoPuzzle" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dayKey" TEXT,
    "creatorId" TEXT,
    "roomId" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "z" DOUBLE PRECISION NOT NULL,
    "yaw" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pose" TEXT NOT NULL DEFAULT 'stand',
    "morphId" TEXT NOT NULL DEFAULT 'classic',
    "look" JSONB,
    "strokes" BYTEA NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'player',
    "expiresAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "found" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CamoPuzzle_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CamoPuzzle_dayKey_key" ON "CamoPuzzle"("dayKey");
CREATE INDEX "CamoPuzzle_creatorId_createdAt_idx" ON "CamoPuzzle"("creatorId", "createdAt");
CREATE INDEX "CamoPuzzle_kind_createdAt_idx" ON "CamoPuzzle"("kind", "createdAt");

CREATE TABLE "CamoPuzzleAttempt" (
    "id" TEXT NOT NULL,
    "puzzleId" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "success" BOOLEAN NOT NULL,
    "foundMs" INTEGER,
    "tags" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CamoPuzzleAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CamoPuzzleAttempt_puzzleId_createdAt_idx" ON "CamoPuzzleAttempt"("puzzleId", "createdAt");
CREATE INDEX "CamoPuzzleAttempt_userId_createdAt_idx" ON "CamoPuzzleAttempt"("userId", "createdAt");
