-- Owner OS: booking sources, venue payment mode, commission snapshots, ledger, settlements.
-- Additive only: new enums, columns with defaults, tables, indexes. No drops/renames.

CREATE TYPE "BookingSource" AS ENUM ('platform', 'manual');
CREATE TYPE "VenuePaymentMode" AS ENUM ('at_venue', 'online');
CREATE TYPE "LedgerEntryKind" AS ENUM ('booking_accrual', 'booking_adjustment', 'payout_to_owner', 'remittance_from_owner', 'manual_adjustment');
CREATE TYPE "SettlementDirection" AS ENUM ('platform_to_owner', 'owner_to_platform');
CREATE TYPE "SettlementStatus" AS ENUM ('pending_confirmation', 'confirmed', 'rejected');

ALTER TABLE "Venue" ADD COLUMN "paymentMode" "VenuePaymentMode" NOT NULL DEFAULT 'at_venue';
ALTER TABLE "Venue" ADD COLUMN "paymentModeChangedAt" TIMESTAMP(3);

ALTER TABLE "Booking" ADD COLUMN "source" "BookingSource" NOT NULL DEFAULT 'platform';
ALTER TABLE "Booking" ADD COLUMN "sourceKey" TEXT;
ALTER TABLE "Booking" ADD COLUMN "sourceLabel" TEXT;
ALTER TABLE "Booking" ADD COLUMN "notes" TEXT;
ALTER TABLE "Booking" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "Booking" ADD COLUMN "paymentModeSnapshot" "VenuePaymentMode";
ALTER TABLE "Booking" ADD COLUMN "ownerFundedDiscount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "commissionBps" INTEGER;
ALTER TABLE "Booking" ADD COLUMN "commissionAmount" INTEGER;
ALTER TABLE "Booking" ADD COLUMN "ownerNetAmount" INTEGER;

CREATE INDEX "Booking_venueId_source_slotStart_idx" ON "Booking"("venueId", "source", "slotStart");
CREATE INDEX "Booking_venueId_status_slotStart_idx" ON "Booking"("venueId", "status", "slotStart");

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "VenueLedgerEntry" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "kind" "LedgerEntryKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "bookingId" TEXT,
    "settlementId" TEXT,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VenueLedgerEntry_venueId_currency_createdAt_idx" ON "VenueLedgerEntry"("venueId", "currency", "createdAt");
CREATE INDEX "VenueLedgerEntry_bookingId_idx" ON "VenueLedgerEntry"("bookingId");
CREATE INDEX "VenueLedgerEntry_settlementId_idx" ON "VenueLedgerEntry"("settlementId");

CREATE TABLE "VenueSettlement" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "direction" "SettlementDirection" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "receiptUrl" TEXT,
    "status" "SettlementStatus" NOT NULL DEFAULT 'confirmed',
    "recordedById" TEXT NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueSettlement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VenueSettlement_venueId_createdAt_idx" ON "VenueSettlement"("venueId", "createdAt");
CREATE INDEX "VenueSettlement_status_idx" ON "VenueSettlement"("status");

CREATE TABLE "VenueBookingSource" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueBookingSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VenueBookingSource_venueId_normalized_key" ON "VenueBookingSource"("venueId", "normalized");
CREATE INDEX "VenueBookingSource_venueId_useCount_idx" ON "VenueBookingSource"("venueId", "useCount");

ALTER TABLE "VenueLedgerEntry" ADD CONSTRAINT "VenueLedgerEntry_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VenueLedgerEntry" ADD CONSTRAINT "VenueLedgerEntry_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VenueLedgerEntry" ADD CONSTRAINT "VenueLedgerEntry_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "VenueSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VenueLedgerEntry" ADD CONSTRAINT "VenueLedgerEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VenueSettlement" ADD CONSTRAINT "VenueSettlement_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VenueSettlement" ADD CONSTRAINT "VenueSettlement_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VenueSettlement" ADD CONSTRAINT "VenueSettlement_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VenueBookingSource" ADD CONSTRAINT "VenueBookingSource_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Postgres treats NULLs as distinct in unique indexes; enforce a single global commission row.
CREATE UNIQUE INDEX "CommissionSetting_global_unique" ON "CommissionSetting" ((1)) WHERE "venueId" IS NULL;

INSERT INTO "CommissionSetting" ("id", "percentageBps", "createdAt")
SELECT gen_random_uuid()::text, 1000, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "CommissionSetting" WHERE "venueId" IS NULL);

-- Backfill existing walk-ins that used the WALKIN- code prefix.
UPDATE "Booking"
SET "source" = 'manual',
    "sourceKey" = 'walk_in',
    "notes" = NULLIF("guestName", '')
WHERE "code" LIKE 'WALKIN-%';
