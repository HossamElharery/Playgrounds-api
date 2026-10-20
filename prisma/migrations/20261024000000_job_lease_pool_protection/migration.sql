CREATE TABLE "JobLease" (
    "name" VARCHAR(120) NOT NULL,
    "ownerId" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);

CREATE INDEX "JobLease_expiresAt_idx" ON "JobLease"("expiresAt");
