-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "bundleId" TEXT,
ADD COLUMN     "membershipCovered" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MatchPost" ADD COLUMN     "gameId" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'match';

-- CreateTable
CREATE TABLE "GameCatalogEntry" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "iconUrl" TEXT,
    "genre" TEXT NOT NULL,
    "supportsCompetitiveTier" BOOLEAN NOT NULL DEFAULT true,
    "ageRating" TEXT NOT NULL DEFAULT 'everyone',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameCatalogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bundle" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "discountPercent" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleItem" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "courtId" TEXT NOT NULL,
    "durationUnits" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "BundleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipPlan" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "priceAmount" INTEGER NOT NULL,
    "priceCurrency" TEXT NOT NULL DEFAULT 'EGP',
    "includedHours" INTEGER NOT NULL,
    "overageDiscountPercent" INTEGER NOT NULL DEFAULT 0,
    "perksEn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "perksAr" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "hoursUsedThisPeriod" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tournament" (
    "id" TEXT NOT NULL,
    "venueId" TEXT,
    "activityId" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'single-elimination',
    "entryFeeAmount" INTEGER,
    "entryFeeCurrency" TEXT,
    "maxParticipants" INTEGER NOT NULL,
    "registrationDeadline" TIMESTAMP(3) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentParticipant" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seed" INTEGER,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentMatch" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "slotAId" TEXT,
    "slotBId" TEXT,
    "winnerId" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "matchPostId" TEXT,
    "resultConfirmedByA" BOOLEAN NOT NULL DEFAULT false,
    "resultConfirmedByB" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TournamentMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GameCatalogEntry_slug_key" ON "GameCatalogEntry"("slug");

-- CreateIndex
CREATE INDEX "Bundle_venueId_idx" ON "Bundle"("venueId");

-- CreateIndex
CREATE INDEX "BundleItem_bundleId_idx" ON "BundleItem"("bundleId");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipPlan_slug_key" ON "MembershipPlan"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "UserMembership_userId_key" ON "UserMembership"("userId");

-- CreateIndex
CREATE INDEX "Tournament_activityId_status_idx" ON "Tournament"("activityId", "status");

-- CreateIndex
CREATE INDEX "Tournament_status_registrationDeadline_idx" ON "Tournament"("status", "registrationDeadline");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentParticipant_tournamentId_userId_key" ON "TournamentParticipant"("tournamentId", "userId");

-- CreateIndex
CREATE INDEX "TournamentMatch_tournamentId_round_idx" ON "TournamentMatch"("tournamentId", "round");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchPost" ADD CONSTRAINT "MatchPost_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "GameCatalogEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleItem" ADD CONSTRAINT "BundleItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleItem" ADD CONSTRAINT "BundleItem_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMembership" ADD CONSTRAINT "UserMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMembership" ADD CONSTRAINT "UserMembership_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MembershipPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentParticipant" ADD CONSTRAINT "TournamentParticipant_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentParticipant" ADD CONSTRAINT "TournamentParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_matchPostId_fkey" FOREIGN KEY ("matchPostId") REFERENCES "MatchPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

