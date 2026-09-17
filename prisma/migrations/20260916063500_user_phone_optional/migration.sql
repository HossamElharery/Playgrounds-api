-- Phone is contact data, not a login identifier. Auth is email / OAuth.
ALTER TABLE "User" ALTER COLUMN "phone" DROP NOT NULL;
