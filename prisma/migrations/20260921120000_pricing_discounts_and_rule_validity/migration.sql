-- AlterTable
ALTER TABLE "PricingRule" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'base',
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "validFrom" TIMESTAMP(3),
ADD COLUMN     "validUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PricingDiscount" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "courtId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startHour" INTEGER NOT NULL,
    "endHour" INTEGER NOT NULL,
    "percent" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "baselineOccupancy" DOUBLE PRECISION,
    "estimatedMonthlyLoss" INTEGER,
    "ruleIds" TEXT[],
    "dismissedUntil" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingDiscount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PricingDiscount_venueId_status_idx" ON "PricingDiscount"("venueId", "status");

-- CreateIndex
CREATE INDEX "PricingDiscount_courtId_weekday_idx" ON "PricingDiscount"("courtId", "weekday");

-- AddForeignKey
ALTER TABLE "PricingDiscount" ADD CONSTRAINT "PricingDiscount_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingDiscount" ADD CONSTRAINT "PricingDiscount_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE CASCADE ON UPDATE CASCADE;

