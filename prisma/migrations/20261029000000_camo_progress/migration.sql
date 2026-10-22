-- Camo game progress: daily coin cap, missions, cosmetics (hand-written; applied to the scratch database only).
ALTER TABLE "CamoStats"
  ADD COLUMN "coinsToday" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "coinsDay" TEXT,
  ADD COLUMN "missions" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "cosmetics" JSONB NOT NULL DEFAULT '{"owned":[],"equipped":{}}';
