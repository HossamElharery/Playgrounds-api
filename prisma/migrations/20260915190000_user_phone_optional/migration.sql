-- Player accounts can now register/login with email or Google/Facebook
-- without a phone number (SMS OTP still works for anyone who has a phone).
-- Drops NOT NULL only; the existing unique index on "phone" is left as-is
-- (Postgres allows any number of NULLs in a unique column/index).

ALTER TABLE "User" ALTER COLUMN "phone" DROP NOT NULL;
