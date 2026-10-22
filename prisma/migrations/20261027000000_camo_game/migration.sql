-- «استغماية»: camo game tables + User.guestSource. Hand-trimmed: Prisma's diff also wanted to drop objects created by
-- earlier raw-SQL migrations (Booking.slotRange, ResourceOccupancy.occupiedRange, ...); none of that belongs here.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "guestSource" TEXT;

-- CreateTable
CREATE TABLE "CamoMatch" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'classic',
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "code" TEXT,
    "rounds" INTEGER NOT NULL DEFAULT 3,
    "botCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),

    CONSTRAINT "CamoMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CamoMatchPlayer" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "morphId" TEXT NOT NULL,
    "roles" JSONB NOT NULL DEFAULT '[]',
    "points" INTEGER NOT NULL DEFAULT 0,
    "caught" INTEGER NOT NULL DEFAULT 0,
    "cardsGiven" INTEGER NOT NULL DEFAULT 0,
    "yellows" INTEGER NOT NULL DEFAULT 0,
    "bestSurvivalMs" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "awards" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "won" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CamoMatchPlayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CamoStats" (
    "userId" TEXT NOT NULL,
    "matches" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "caughtCount" INTEGER NOT NULL DEFAULT 0,
    "cardsGiven" INTEGER NOT NULL DEFAULT 0,
    "yellows" INTEGER NOT NULL DEFAULT 0,
    "bestSurvivalMs" INTEGER NOT NULL DEFAULT 0,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CamoStats_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "CamoReport" (
    "id" TEXT NOT NULL,
    "matchId" TEXT,
    "reporterId" TEXT,
    "targetUserId" TEXT,
    "round" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "counted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CamoReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CamoVote" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "startedBy" TEXT NOT NULL,
    "votes" JSONB NOT NULL DEFAULT '{}',
    "result" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CamoVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CamoRoomBan" (
    "id" TEXT NOT NULL,
    "roomInstanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CamoRoomBan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CamoSanction" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "ipHash" TEXT,
    "kind" TEXT NOT NULL,
    "until" TIMESTAMPTZ(3),
    "source" TEXT NOT NULL DEFAULT 'auto',
    "reportIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CamoSanction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CamoModerationAudit" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetUserId" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CamoModerationAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CamoMatchmakingAvoid" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "avoidUserId" TEXT NOT NULL,
    "until" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CamoMatchmakingAvoid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CamoSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CamoSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "CamoMatch_startedAt_idx" ON "CamoMatch"("startedAt");

-- CreateIndex
CREATE INDEX "CamoMatch_roomId_startedAt_idx" ON "CamoMatch"("roomId", "startedAt");

-- CreateIndex
CREATE INDEX "CamoMatchPlayer_userId_idx" ON "CamoMatchPlayer"("userId");

-- CreateIndex
CREATE INDEX "CamoMatchPlayer_matchId_idx" ON "CamoMatchPlayer"("matchId");

-- CreateIndex
CREATE INDEX "CamoReport_targetUserId_createdAt_idx" ON "CamoReport"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX "CamoReport_status_createdAt_idx" ON "CamoReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CamoReport_reporterId_createdAt_idx" ON "CamoReport"("reporterId", "createdAt");

-- CreateIndex
CREATE INDEX "CamoVote_matchId_idx" ON "CamoVote"("matchId");

-- CreateIndex
CREATE INDEX "CamoVote_startedBy_createdAt_idx" ON "CamoVote"("startedBy", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CamoRoomBan_roomInstanceId_userId_key" ON "CamoRoomBan"("roomInstanceId", "userId");

-- CreateIndex
CREATE INDEX "CamoSanction_userId_until_idx" ON "CamoSanction"("userId", "until");

-- CreateIndex
CREATE INDEX "CamoSanction_deviceId_until_idx" ON "CamoSanction"("deviceId", "until");

-- CreateIndex
CREATE INDEX "CamoSanction_ipHash_until_idx" ON "CamoSanction"("ipHash", "until");

-- CreateIndex
CREATE INDEX "CamoModerationAudit_targetUserId_createdAt_idx" ON "CamoModerationAudit"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX "CamoModerationAudit_createdAt_idx" ON "CamoModerationAudit"("createdAt");

-- CreateIndex
CREATE INDEX "CamoMatchmakingAvoid_until_idx" ON "CamoMatchmakingAvoid"("until");

-- CreateIndex
CREATE UNIQUE INDEX "CamoMatchmakingAvoid_userId_avoidUserId_key" ON "CamoMatchmakingAvoid"("userId", "avoidUserId");

-- CreateIndex
CREATE INDEX "User_guestSource_createdAt_idx" ON "User"("guestSource", "createdAt");

-- AddForeignKey
ALTER TABLE "CamoMatchPlayer" ADD CONSTRAINT "CamoMatchPlayer_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "CamoMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CamoMatchPlayer" ADD CONSTRAINT "CamoMatchPlayer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CamoStats" ADD CONSTRAINT "CamoStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CamoReport" ADD CONSTRAINT "CamoReport_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "CamoMatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CamoReport" ADD CONSTRAINT "CamoReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CamoReport" ADD CONSTRAINT "CamoReport_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CamoSanction" ADD CONSTRAINT "CamoSanction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
