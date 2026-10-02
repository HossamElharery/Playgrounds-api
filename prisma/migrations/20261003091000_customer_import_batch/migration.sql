-- AlterTable
ALTER TABLE "VenueCustomer" ADD COLUMN     "importBatchId" TEXT;

-- CreateIndex
CREATE INDEX "VenueCustomer_importBatchId_idx" ON "VenueCustomer"("importBatchId");
