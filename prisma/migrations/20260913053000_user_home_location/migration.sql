-- AlterTable
ALTER TABLE "User" ADD COLUMN "governorateId" TEXT;
ALTER TABLE "User" ADD COLUMN "districtId" TEXT;
ALTER TABLE "User" ADD COLUMN "locationLat" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN "locationLng" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN "locationUpdatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_governorateId_idx" ON "User"("governorateId");
CREATE INDEX "User_districtId_idx" ON "User"("districtId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_governorateId_fkey" FOREIGN KEY ("governorateId") REFERENCES "Governorate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;
