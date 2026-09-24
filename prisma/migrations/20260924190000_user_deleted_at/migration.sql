-- Self-service account deletion (App Store 5.1.1(v) / Google Play account deletion policy).
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
