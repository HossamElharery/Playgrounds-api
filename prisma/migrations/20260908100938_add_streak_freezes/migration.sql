-- MAL3AB_ENGAGEMENT_ENGINE_BLUEPRINT.md §4.3 — burnable streak-protection tokens
ALTER TABLE "User" ADD COLUMN "streakFreezes" INTEGER NOT NULL DEFAULT 0;
