-- AlterTable
ALTER TABLE "User" ADD COLUMN "isGuest" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SquadInviteLink" (
    "id" TEXT NOT NULL,
    "squadId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquadInviteLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SquadInviteLink_squadId_key" ON "SquadInviteLink"("squadId");

-- CreateIndex
CREATE INDEX "SquadInviteLink_expiresAt_idx" ON "SquadInviteLink"("expiresAt");

-- CreateIndex
CREATE INDEX "User_isGuest_createdAt_idx" ON "User"("isGuest", "createdAt");

-- AddForeignKey
ALTER TABLE "SquadInviteLink" ADD CONSTRAINT "SquadInviteLink_squadId_fkey" FOREIGN KEY ("squadId") REFERENCES "Squad"("id") ON DELETE CASCADE ON UPDATE CASCADE;
