-- Daily cap on cold direct messages + message-request state. Additive only:
-- every existing thread becomes requestState 'none' and behaves exactly as before.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "strangerContactLimit" INTEGER;
ALTER TABLE "ChatThread" ADD COLUMN IF NOT EXISTS "requestState" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "ChatThread" ADD COLUMN IF NOT EXISTS "requestedById" TEXT;
ALTER TABLE "ChatThread" ADD COLUMN IF NOT EXISTS "requestedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "ChatThread_requestedById_requestedAt_idx" ON "ChatThread"("requestedById", "requestedAt");
ALTER TABLE "User" ADD CONSTRAINT "User_strangerContactLimit_range" CHECK ("strangerContactLimit" IS NULL OR ("strangerContactLimit" >= 0 AND "strangerContactLimit" <= 100));
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_requestState_valid" CHECK ("requestState" IN ('none','pending','accepted','declined'));
