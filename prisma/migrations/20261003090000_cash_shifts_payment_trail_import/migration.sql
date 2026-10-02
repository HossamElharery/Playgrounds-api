-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "importBatchId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "note" TEXT,
ADD COLUMN     "recordedByUserId" TEXT,
ADD COLUMN     "reversesPaymentId" TEXT,
ADD COLUMN     "shiftId" TEXT;

-- AlterTable
ALTER TABLE "VenueExpense" ADD COLUMN     "fromDrawer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shiftId" TEXT;

-- CreateTable
CREATE TABLE "CashShift" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "drawerUserId" TEXT,
    "closedByUserId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloat" INTEGER NOT NULL DEFAULT 0,
    "cashIn" INTEGER NOT NULL DEFAULT 0,
    "cashRefunds" INTEGER NOT NULL DEFAULT 0,
    "cashExpenses" INTEGER NOT NULL DEFAULT 0,
    "expectedCash" INTEGER NOT NULL DEFAULT 0,
    "countedCash" INTEGER NOT NULL DEFAULT 0,
    "difference" INTEGER NOT NULL DEFAULT 0,
    "carryOver" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "breakdown" JSONB NOT NULL,
    "note" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNote" TEXT,

    CONSTRAINT "CashShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueCustomer" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "note" TEXT,
    "imported" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueImportBatch" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "fileName" TEXT,
    "rowsTotal" INTEGER NOT NULL DEFAULT 0,
    "bookings" INTEGER NOT NULL DEFAULT 0,
    "customers" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Booking_importBatchId_idx" ON "Booking"("importBatchId");

-- CreateIndex
CREATE INDEX "CashShift_venueId_closedAt_idx" ON "CashShift"("venueId", "closedAt");

-- CreateIndex
CREATE INDEX "CashShift_venueId_drawerUserId_closedAt_idx" ON "CashShift"("venueId", "drawerUserId", "closedAt");

-- CreateIndex
CREATE INDEX "VenueCustomer_venueId_idx" ON "VenueCustomer"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueCustomer_venueId_key_key" ON "VenueCustomer"("venueId", "key");

-- CreateIndex
CREATE INDEX "VenueImportBatch_venueId_createdAt_idx" ON "VenueImportBatch"("venueId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_reversesPaymentId_key" ON "Payment"("reversesPaymentId");

-- CreateIndex
CREATE INDEX "Payment_shiftId_idx" ON "Payment"("shiftId");

-- CreateIndex
CREATE INDEX "Payment_recordedByUserId_shiftId_idx" ON "Payment"("recordedByUserId", "shiftId");

-- CreateIndex
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "CashShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashShift" ADD CONSTRAINT "CashShift_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueCustomer" ADD CONSTRAINT "VenueCustomer_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueImportBatch" ADD CONSTRAINT "VenueImportBatch_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

