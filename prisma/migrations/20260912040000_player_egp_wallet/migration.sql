-- Prepaid EGP wallet (piasters). Distinct from coinsBalance (rewards).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "walletBalance" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "WalletLedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "method" "PaymentMethod",
    "bookingId" TEXT,
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WalletLedgerEntry_userId_createdAt_idx" ON "WalletLedgerEntry"("userId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WalletLedgerEntry_userId_fkey'
  ) THEN
    ALTER TABLE "WalletLedgerEntry"
      ADD CONSTRAINT "WalletLedgerEntry_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WalletLedgerEntry_bookingId_fkey'
  ) THEN
    ALTER TABLE "WalletLedgerEntry"
      ADD CONSTRAINT "WalletLedgerEntry_bookingId_fkey"
      FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
