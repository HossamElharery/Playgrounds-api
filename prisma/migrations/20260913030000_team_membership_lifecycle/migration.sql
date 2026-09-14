ALTER TABLE "Team" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE TABLE "TeamMembershipRequest" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "respondedAt" TIMESTAMP(3),
  CONSTRAINT "TeamMembershipRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeamMembershipRequest_status_check" CHECK ("status" IN ('pending', 'accepted', 'declined', 'cancelled'))
);
CREATE INDEX "TeamMembershipRequest_teamId_status_idx" ON "TeamMembershipRequest"("teamId", "status");
CREATE INDEX "TeamMembershipRequest_userId_status_idx" ON "TeamMembershipRequest"("userId", "status");
CREATE UNIQUE INDEX "TeamMembershipRequest_one_pending" ON "TeamMembershipRequest"("teamId", "userId") WHERE "status" = 'pending';
ALTER TABLE "TeamMembershipRequest" ADD CONSTRAINT "TeamMembershipRequest_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMembershipRequest" ADD CONSTRAINT "TeamMembershipRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMembershipRequest" ADD CONSTRAINT "TeamMembershipRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
