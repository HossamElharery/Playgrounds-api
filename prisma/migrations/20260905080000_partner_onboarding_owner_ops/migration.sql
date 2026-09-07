-- Partner onboarding (§20) + owner operations (§21)

CREATE TYPE "PartnerApplicationStatus" AS ENUM (
  'draft',
  'pending',
  'changes_requested',
  'approved',
  'rejected',
  'suspended'
);

CREATE TYPE "CalendarBlockKind" AS ENUM ('maintenance', 'private');

CREATE TYPE "PayoutMethodKind" AS ENUM ('bank', 'instapay', 'wallet');

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
CREATE INDEX IF NOT EXISTS "User_username_idx" ON "User"("username");

ALTER TABLE "Venue"
  ADD COLUMN IF NOT EXISTS "weeklyHours" JSONB,
  ADD COLUMN IF NOT EXISTS "contactPhone" TEXT,
  ADD COLUMN IF NOT EXISTS "legalBusinessName" TEXT,
  ADD COLUMN IF NOT EXISTS "registrationNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "houseRules" TEXT;

ALTER TABLE "Court" ADD COLUMN IF NOT EXISTS "spec" JSONB;

ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "guestName" TEXT,
  ADD COLUMN IF NOT EXISTS "guestPhone" TEXT;

ALTER TABLE "Badge" ADD COLUMN IF NOT EXISTS "iconKey" TEXT;

ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "StaffInvite"
  ALTER COLUMN "inviteePhone" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "inviteeEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "operationalRole" TEXT;

CREATE TABLE "PartnerApplication" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "venueId" TEXT,
  "status" "PartnerApplicationStatus" NOT NULL DEFAULT 'draft',
  "version" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "publicNameEn" TEXT NOT NULL,
  "publicNameAr" TEXT NOT NULL,
  "contactPhone" TEXT NOT NULL,
  "countryCode" TEXT NOT NULL DEFAULT 'EG',
  "governorateId" TEXT,
  "districtId" TEXT,
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "submittedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PartnerApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PartnerApplication_venueId_key" ON "PartnerApplication"("venueId");
CREATE INDEX "PartnerApplication_ownerId_createdAt_idx" ON "PartnerApplication"("ownerId", "createdAt");
CREATE INDEX "PartnerApplication_status_createdAt_idx" ON "PartnerApplication"("status", "createdAt");

CREATE TABLE "PartnerApplicationEvent" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "fromStatus" "PartnerApplicationStatus" NOT NULL,
  "toStatus" "PartnerApplicationStatus" NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PartnerApplicationEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PartnerApplicationEvent_applicationId_createdAt_idx"
  ON "PartnerApplicationEvent"("applicationId", "createdAt");

CREATE TABLE "CalendarBlock" (
  "id" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "courtId" TEXT,
  "kind" "CalendarBlockKind" NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "note" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CalendarBlock_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CalendarBlock_venueId_startsAt_idx" ON "CalendarBlock"("venueId", "startsAt");
CREATE INDEX "CalendarBlock_courtId_startsAt_idx" ON "CalendarBlock"("courtId", "startsAt");

CREATE TABLE "PayoutMethod" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "kind" "PayoutMethodKind" NOT NULL,
  "accountHolder" TEXT NOT NULL,
  "identifierMasked" TEXT NOT NULL,
  "bankName" TEXT,
  "details" JSONB,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PayoutMethod_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PayoutMethod_ownerId_idx" ON "PayoutMethod"("ownerId");

ALTER TABLE "PartnerApplication"
  ADD CONSTRAINT "PartnerApplication_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PartnerApplication"
  ADD CONSTRAINT "PartnerApplication_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PartnerApplicationEvent"
  ADD CONSTRAINT "PartnerApplicationEvent_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "PartnerApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PartnerApplicationEvent"
  ADD CONSTRAINT "PartnerApplicationEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CalendarBlock"
  ADD CONSTRAINT "CalendarBlock_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CalendarBlock"
  ADD CONSTRAINT "CalendarBlock_courtId_fkey"
  FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CalendarBlock"
  ADD CONSTRAINT "CalendarBlock_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayoutMethod"
  ADD CONSTRAINT "PayoutMethod_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "StaffInviteStatus" ADD VALUE IF NOT EXISTS 'suspended';
