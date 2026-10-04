ALTER TABLE "Payment" ADD COLUMN "manualRequestKey" TEXT;
CREATE UNIQUE INDEX "Payment_manualRequestKey_key" ON "Payment"("manualRequestKey");
