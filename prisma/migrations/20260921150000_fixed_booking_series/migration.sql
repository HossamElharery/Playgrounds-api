-- Owner fixed (weekly recurring) bookings: additive extension of RecurringBookingSeries.
ALTER TABLE "RecurringBookingSeries" DROP CONSTRAINT "RecurringBookingSeries_userId_fkey";

ALTER TABLE "RecurringBookingSeries" ADD COLUMN     "conflictDates" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "customerPhone" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'player',
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "paymentPlan" TEXT NOT NULL DEFAULT 'per_session',
ADD COLUMN     "priceAmount" INTEGER,
ADD COLUMN     "skippedDates" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sourceKey" TEXT,
ADD COLUMN     "sourceLabel" TEXT,
ADD COLUMN     "startDate" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "until" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "venueId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

CREATE INDEX "RecurringBookingSeries_venueId_status_idx" ON "RecurringBookingSeries"("venueId", "status");

ALTER TABLE "RecurringBookingSeries" ADD CONSTRAINT "RecurringBookingSeries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
