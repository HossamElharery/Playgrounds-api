-- Additive: the owner assistant request text, shown to admins only. Existing rows keep NULL.
ALTER TABLE "AiOwnerEventLog" ADD COLUMN "text" VARCHAR(500);
