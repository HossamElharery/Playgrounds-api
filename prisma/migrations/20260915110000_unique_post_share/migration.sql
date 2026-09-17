-- One share event per user per post. Recount after collapsing duplicates.
DELETE FROM "PostShare" a
USING "PostShare" b
WHERE a."postId" = b."postId"
  AND a."userId" = b."userId"
  AND a."id" > b."id";

CREATE UNIQUE INDEX IF NOT EXISTS "PostShare_postId_userId_key" ON "PostShare"("postId", "userId");

UPDATE "Post" p
SET "shareCount" = (
  SELECT COUNT(*)::int FROM "PostShare" s WHERE s."postId" = p."id"
);
