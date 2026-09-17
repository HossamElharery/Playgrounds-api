-- Tracks whether a tournament entry fee was actually charged, and how much,
-- so registration can be gated on payment and withdrawal can refund the
-- right amount instead of a fee everyone quietly skipped.
ALTER TABLE "TournamentParticipant" ADD COLUMN "entryFeePaid" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TournamentParticipant" ADD COLUMN "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'paid';
