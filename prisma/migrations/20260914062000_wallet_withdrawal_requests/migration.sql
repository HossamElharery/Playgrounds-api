-- Money went into the wallet (top-up) with no path out at all. This adds a
-- withdrawal-request table: the wallet is debited on request (reserving the
-- funds), an admin marks it paid once the transfer happens outside the app
-- (no payout provider is wired up yet), or rejects it and the funds are
-- refunded back to the wallet.
CREATE TYPE "WalletWithdrawalStatus" AS ENUM ('pending', 'paid', 'rejected');

CREATE TABLE "WalletWithdrawalRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "destination" TEXT NOT NULL,
    "status" "WalletWithdrawalStatus" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "WalletWithdrawalRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WalletWithdrawalRequest_status_createdAt_idx" ON "WalletWithdrawalRequest"("status", "createdAt");
CREATE INDEX "WalletWithdrawalRequest_userId_createdAt_idx" ON "WalletWithdrawalRequest"("userId", "createdAt");

ALTER TABLE "WalletWithdrawalRequest" ADD CONSTRAINT "WalletWithdrawalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalletWithdrawalRequest" ADD CONSTRAINT "WalletWithdrawalRequest_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
