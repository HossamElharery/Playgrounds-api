CREATE TABLE "GamingLayout" (
  "venueId" TEXT PRIMARY KEY REFERENCES "Venue"("id") ON DELETE CASCADE,
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "draftVersion" INTEGER NOT NULL DEFAULT 0 CHECK ("draftVersion" >= 0),
  "draft" JSONB,
  "draftByUserId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "GamingLayoutRevision" (
  "id" TEXT PRIMARY KEY,
  "venueId" TEXT NOT NULL REFERENCES "Venue"("id") ON DELETE CASCADE,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "document" JSONB NOT NULL,
  "requestKey" TEXT NOT NULL UNIQUE,
  "requestHash" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("venueId", "revision")
);
CREATE INDEX "GamingLayoutRevision_venueId_createdAt_idx" ON "GamingLayoutRevision"("venueId", "createdAt");
