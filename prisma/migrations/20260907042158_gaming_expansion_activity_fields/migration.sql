-- Mal3ab gaming expansion (MAL3AB_GAMING_EXPANSION_BLUEPRINT.md §3.1/§7.4)
-- Purely additive, nullable columns — no data loss, no existing behavior change.

ALTER TABLE "SportCategory" ADD COLUMN "activityKind" TEXT;
ALTER TABLE "Court" ADD COLUMN "gamingConfig" JSONB;
ALTER TABLE "Court" ADD COLUMN "tableConfig" JSONB;
ALTER TABLE "Court" ADD COLUMN "ageRating" TEXT;
