-- PostShare is introduced by the immediately preceding migration in this release,
-- so adding the uniqueness constraint is safe and requires no data mutation.
CREATE UNIQUE INDEX IF NOT EXISTS "PostShare_postId_userId_key" ON "PostShare"("postId", "userId");
