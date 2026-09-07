-- Public blog URLs are /blog/:slug. Existing rows fall back to their id.
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "slug" TEXT;

UPDATE "BlogPost"
SET "slug" = "id"
WHERE "slug" IS NULL OR "slug" = '';

CREATE UNIQUE INDEX IF NOT EXISTS "BlogPost_slug_key" ON "BlogPost"("slug");

ALTER TABLE "BlogPost" ALTER COLUMN "slug" SET NOT NULL;
