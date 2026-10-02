-- AlterTable
ALTER TABLE "AiQuestionLog" ADD COLUMN     "replyText" VARCHAR(700),
ADD COLUMN     "userId" VARCHAR(40);

-- CreateTable
CREATE TABLE "AssistantTranscript" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerId" TEXT NOT NULL,
    "ownerName" TEXT,
    "venueId" TEXT,
    "venueName" TEXT,
    "sender" "AssistantSender" NOT NULL,
    "kind" VARCHAR(12) NOT NULL DEFAULT 'chat',
    "text" TEXT NOT NULL,
    "intent" VARCHAR(40),
    "outcome" VARCHAR(24),
    "confidence" DOUBLE PRECISION,
    "model" VARCHAR(120),
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "meta" JSONB,
    "source" VARCHAR(8) NOT NULL DEFAULT 'server',
    "clientCopy" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AssistantTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssistantTranscript_ownerId_createdAt_idx" ON "AssistantTranscript"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantTranscript_venueId_createdAt_idx" ON "AssistantTranscript"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantTranscript_createdAt_idx" ON "AssistantTranscript"("createdAt");

-- CreateIndex
CREATE INDEX "AiQuestionLog_userId_createdAt_idx" ON "AiQuestionLog"("userId", "createdAt");

-- Everything the owners and the assistant have already said moves into the permanent record.
-- (The hidden "undo point" rows are bookkeeping, not conversation.)
INSERT INTO "AssistantTranscript" ("id", "createdAt", "ownerId", "ownerName", "venueId", "venueName", "sender", "kind", "text", "source")
SELECT m."id", m."createdAt", m."ownerId", u."name", m."venueId", COALESCE(v."nameAr", v."nameEn"), m."sender",
       CASE WHEN m."sender" = 'system' THEN 'schedule' ELSE 'chat' END, m."text", 'client'
FROM "AssistantMessage" m
LEFT JOIN "User" u ON u."id" = m."ownerId"
LEFT JOIN "Venue" v ON v."id" = m."venueId"
WHERE m."text" <> 'assistant-undo'
ON CONFLICT ("id") DO NOTHING;
