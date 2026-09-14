-- Persists the owner-facing "schedule assistant" chat (ScheduleConsoleComponent)
-- so the log and the single-step undo token survive a reload instead of
-- living only in frontend signals.
CREATE TYPE "AssistantSender" AS ENUM ('owner', 'assistant', 'system');

CREATE TABLE "AssistantMessage" (
  "id" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "sender" "AssistantSender" NOT NULL,
  "text" TEXT NOT NULL,
  "appliedChange" JSONB,
  "inverseChange" JSONB,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AssistantMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AssistantMessage_venueId_createdAt_idx" ON "AssistantMessage"("venueId", "createdAt");
CREATE INDEX "AssistantMessage_ownerId_createdAt_idx" ON "AssistantMessage"("ownerId", "createdAt");

ALTER TABLE "AssistantMessage"
  ADD CONSTRAINT "AssistantMessage_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssistantMessage"
  ADD CONSTRAINT "AssistantMessage_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
