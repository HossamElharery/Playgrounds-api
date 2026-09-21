-- CreateTable
CREATE TABLE "PlatformBookingRequest" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "adminReply" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformBookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformBookingRequest_venueId_status_idx" ON "PlatformBookingRequest"("venueId", "status");

-- CreateIndex
CREATE INDEX "PlatformBookingRequest_status_createdAt_idx" ON "PlatformBookingRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformBookingRequest_bookingId_idx" ON "PlatformBookingRequest"("bookingId");

-- AddForeignKey
ALTER TABLE "PlatformBookingRequest" ADD CONSTRAINT "PlatformBookingRequest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformBookingRequest" ADD CONSTRAINT "PlatformBookingRequest_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
