-- Additive: existing posts retain their named author.
ALTER TABLE "Post" ADD COLUMN "isAnonymous" BOOLEAN NOT NULL DEFAULT false;
