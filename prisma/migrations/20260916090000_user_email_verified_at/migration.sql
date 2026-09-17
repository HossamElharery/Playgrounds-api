-- Track proof of mailbox ownership for new email/password registrations.
-- Existing accounts remain usable; new registrations set this timestamp only
-- after a valid, single-use email OTP is consumed.
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
