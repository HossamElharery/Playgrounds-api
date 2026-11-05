-- Smart-TV control through the Matchena Hub: a TV is a GamingDevice with provider "tv". The hub reports a few
-- extra facts per device (can it be woken from standby, how it is linked), kept as plain JSON.
ALTER TABLE "GamingDevice" ADD COLUMN "meta" JSONB;
