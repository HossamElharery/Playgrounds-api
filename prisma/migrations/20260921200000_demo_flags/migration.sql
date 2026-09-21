-- Sales-demo venues and their fake accounts are flagged so every real figure and public surface can exclude them.
ALTER TABLE "User" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Venue" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
