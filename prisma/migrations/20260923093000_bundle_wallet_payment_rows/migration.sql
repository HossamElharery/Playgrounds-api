-- Wallet bookings that were confirmed without a Payment row (bundle checkout)
-- showed as unpaid on the owner dashboard. Record the charge that already happened.
INSERT INTO "Payment" ("id", "bookingId", "amount", "currency", "method", "status", "providerRef", "createdAt")
SELECT gen_random_uuid()::text,
       b."id",
       b."totalAmount",
       b."currency",
       'wallet',
       'paid',
       'wallet',
       NOW()
FROM "Booking" b
WHERE b."paymentStatus" = 'paid'
  AND b."paymentMethod" = 'wallet'
  AND NOT EXISTS (
    SELECT 1 FROM "Payment" p WHERE p."bookingId" = b."id" AND p."status" = 'paid'
  );
