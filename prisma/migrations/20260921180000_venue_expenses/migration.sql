-- CreateTable
CREATE TABLE "VenueExpense" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "categoryLabel" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "incurredOn" TEXT NOT NULL,
    "note" TEXT,
    "recurringMonthly" BOOLEAN NOT NULL DEFAULT false,
    "recurringUntil" TEXT,
    "recurringParentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VenueExpense_venueId_incurredOn_idx" ON "VenueExpense"("venueId", "incurredOn");

-- CreateIndex
CREATE UNIQUE INDEX "VenueExpense_recurringParentId_incurredOn_key" ON "VenueExpense"("recurringParentId", "incurredOn");

-- AddForeignKey
ALTER TABLE "VenueExpense" ADD CONSTRAINT "VenueExpense_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueExpense" ADD CONSTRAINT "VenueExpense_recurringParentId_fkey" FOREIGN KEY ("recurringParentId") REFERENCES "VenueExpense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
