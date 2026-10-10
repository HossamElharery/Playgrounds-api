CREATE TABLE "LobbySocialState" (
  "squadId" TEXT PRIMARY KEY REFERENCES "Squad"("id") ON DELETE CASCADE,
  "state" JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "LobbySocialExposure" (
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "roundId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "seenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "roundId")
);
CREATE INDEX "LobbySocialExposure_userId_familyId_idx" ON "LobbySocialExposure"("userId", "familyId");
