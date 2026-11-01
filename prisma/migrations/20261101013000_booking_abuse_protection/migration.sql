ALTER TABLE "User"
  ADD COLUMN "bookingBlockedUntil" TIMESTAMP(3),
  ADD COLUMN "bookingBlockLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "bookingBlockReason" TEXT;

ALTER TABLE "Booking"
  ADD COLUMN "cancellationActor" TEXT;

CREATE INDEX "Booking_userId_cancellationActor_cancelledAt_idx"
  ON "Booking"("userId", "cancellationActor", "cancelledAt");

CREATE INDEX "User_bookingBlockedUntil_idx"
  ON "User"("bookingBlockedUntil");
