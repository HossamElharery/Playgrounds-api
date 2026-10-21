-- WhatsApp messages the venue sends to its own customers (click-to-chat, no API):
-- remember the last one per booking, and let each venue add its own line.
ALTER TABLE "Booking" ADD COLUMN "customerMessagedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "customerMessageKind" TEXT;
ALTER TABLE "Venue" ADD COLUMN "customerMessageNote" TEXT;
