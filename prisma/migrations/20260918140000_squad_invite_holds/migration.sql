-- CreateTable
CREATE TABLE "SquadInviteHold" (
    "id" TEXT NOT NULL,
    "holderId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquadInviteHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SquadInviteHold_holderId_fromUserId_key" ON "SquadInviteHold"("holderId", "fromUserId");

-- CreateIndex
CREATE INDEX "SquadInviteHold_fromUserId_until_idx" ON "SquadInviteHold"("fromUserId", "until");

-- AddForeignKey
ALTER TABLE "SquadInviteHold" ADD CONSTRAINT "SquadInviteHold_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadInviteHold" ADD CONSTRAINT "SquadInviteHold_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
