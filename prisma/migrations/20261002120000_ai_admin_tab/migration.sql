-- CreateEnum
CREATE TYPE "AiSurface" AS ENUM ('captain', 'smart_search');

-- CreateEnum
CREATE TYPE "AiAskerKind" AS ENUM ('guest', 'player');

-- CreateEnum
CREATE TYPE "AiQuestionOutcome" AS ENUM ('answered_fact', 'answered_faq', 'venues', 'no_results', 'bookings', 'nav', 'smalltalk', 'unanswered', 'clarify', 'limited', 'unavailable', 'blocked');

-- CreateEnum
CREATE TYPE "AiQuestionStatus" AS ENUM ('new', 'reviewed', 'resolved', 'ignored');

-- CreateEnum
CREATE TYPE "AiFeedback" AS ENUM ('up', 'down');

-- CreateEnum
CREATE TYPE "AssistantKnowledgeFlag" AS ENUM ('morphs', 'movement', 'ball', 'kiosk');

-- CreateTable
CREATE TABLE "AiCallDaily" (
    "day" DATE NOT NULL,
    "profile" VARCHAR(16) NOT NULL,
    "provider" VARCHAR(24) NOT NULL,
    "model" VARCHAR(120) NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "fallbackCalls" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "totalMs" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCallDaily_pkey" PRIMARY KEY ("day","profile","provider","model")
);

-- CreateTable
CREATE TABLE "AiCounterDaily" (
    "day" DATE NOT NULL,
    "scope" VARCHAR(40) NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCounterDaily_pkey" PRIMARY KEY ("day","scope","key")
);

-- CreateTable
CREATE TABLE "AiQuestionLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "surface" "AiSurface" NOT NULL DEFAULT 'captain',
    "userKind" "AiAskerKind" NOT NULL,
    "textRedacted" VARCHAR(400) NOT NULL,
    "lang" VARCHAR(2),
    "intent" VARCHAR(40),
    "outcome" "AiQuestionOutcome" NOT NULL,
    "detail" VARCHAR(60),
    "factIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reading" JSONB,
    "model" VARCHAR(120),
    "ms" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "askerRef" VARCHAR(16),
    "feedback" "AiFeedback",
    "feedbackAt" TIMESTAMP(3),
    "status" "AiQuestionStatus" NOT NULL DEFAULT 'new',
    "resolvedNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedKnowledgeId" VARCHAR(60),
    "verifiedOk" BOOLEAN,

    CONSTRAINT "AiQuestionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiOwnerEventLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "venueId" TEXT,
    "userId" TEXT,
    "event" VARCHAR(16) NOT NULL,
    "intent" VARCHAR(40),
    "outcome" VARCHAR(24) NOT NULL,
    "detail" VARCHAR(60),
    "confidence" DOUBLE PRECISION,
    "model" VARCHAR(120),
    "ms" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AiOwnerEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantKnowledge" (
    "id" VARCHAR(60) NOT NULL,
    "topicAr" VARCHAR(200) NOT NULL,
    "topicEn" VARCHAR(200) NOT NULL,
    "ar" TEXT NOT NULL,
    "en" TEXT NOT NULL,
    "ctaTarget" VARCHAR(100),
    "ctaLabelAr" VARCHAR(80),
    "ctaLabelEn" VARCHAR(80),
    "flag" "AssistantKnowledgeFlag",
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantKnowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantKnowledgeRevision" (
    "id" TEXT NOT NULL,
    "knowledgeId" VARCHAR(60) NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantKnowledgeRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSetting" (
    "key" VARCHAR(60) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AiEvalRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" VARCHAR(16) NOT NULL,
    "models" TEXT[],
    "source" VARCHAR(16) NOT NULL,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL,
    "triggeredById" TEXT,

    CONSTRAINT "AiEvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiCallDaily_day_idx" ON "AiCallDaily"("day");

-- CreateIndex
CREATE INDEX "AiCounterDaily_day_scope_count_idx" ON "AiCounterDaily"("day", "scope", "count");

-- CreateIndex
CREATE INDEX "AiQuestionLog_createdAt_idx" ON "AiQuestionLog"("createdAt");

-- CreateIndex
CREATE INDEX "AiQuestionLog_outcome_status_idx" ON "AiQuestionLog"("outcome", "status");

-- CreateIndex
CREATE INDEX "AiQuestionLog_feedback_status_idx" ON "AiQuestionLog"("feedback", "status");

-- CreateIndex
CREATE INDEX "AiOwnerEventLog_createdAt_idx" ON "AiOwnerEventLog"("createdAt");

-- CreateIndex
CREATE INDEX "AiOwnerEventLog_venueId_createdAt_idx" ON "AiOwnerEventLog"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "AiOwnerEventLog_outcome_createdAt_idx" ON "AiOwnerEventLog"("outcome", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantKnowledge_active_position_idx" ON "AssistantKnowledge"("active", "position");

-- CreateIndex
CREATE INDEX "AssistantKnowledgeRevision_knowledgeId_createdAt_idx" ON "AssistantKnowledgeRevision"("knowledgeId", "createdAt");

-- CreateIndex
CREATE INDEX "AiEvalRun_createdAt_idx" ON "AiEvalRun"("createdAt");

-- CreateIndex
CREATE INDEX "AiEvalRun_kind_createdAt_idx" ON "AiEvalRun"("kind", "createdAt");

