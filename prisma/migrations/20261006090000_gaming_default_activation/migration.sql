-- Gaming venues run sessions, products and receipts from approval onwards. Existing approved venues
-- that declare consoles / table games are switched on once; the flags stay editable afterwards
-- (turning them off still blocks only NEW sessions, never an open bill).
UPDATE "Venue" v
SET "gamingSessionsEnabled" = true,
    "gamingProductsEnabled" = true,
    "gamingReceiptsEnabled" = true
WHERE v."status" = 'active'
  AND v."approvedAt" IS NOT NULL
  AND (
    EXISTS (
      SELECT 1 FROM "VenueSport" vs JOIN "SportCategory" s ON s."id" = vs."sportId"
      WHERE vs."venueId" = v."id" AND s."activityKind" IN ('gaming-station', 'table-game')
    )
    OR EXISTS (
      SELECT 1 FROM "Court" c JOIN "SportCategory" s ON s."id" = c."sportId"
      WHERE c."venueId" = v."id" AND s."activityKind" IN ('gaming-station', 'table-game')
    )
  )
  AND (NOT v."gamingSessionsEnabled" OR NOT v."gamingProductsEnabled" OR NOT v."gamingReceiptsEnabled");
