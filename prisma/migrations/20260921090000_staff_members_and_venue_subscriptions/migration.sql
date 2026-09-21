-- CreateTable
CREATE TABLE "StaffMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT,
    "permissions" TEXT[],
    "venueIds" TEXT[],
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueSubscription" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "planKey" TEXT NOT NULL DEFAULT 'pro',
    "listPriceAmount" INTEGER NOT NULL DEFAULT 300000,
    "agreedPriceAmount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "graceDays" INTEGER NOT NULL DEFAULT 14,
    "notes" TEXT,
    "lastNoticeDate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "method" TEXT,
    "daysAdded" INTEGER NOT NULL,
    "periodEndBefore" TIMESTAMP(3) NOT NULL,
    "periodEndAfter" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffMember_userId_key" ON "StaffMember"("userId");

-- CreateIndex
CREATE INDEX "StaffMember_ownerId_idx" ON "StaffMember"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueSubscription_venueId_key" ON "VenueSubscription"("venueId");

-- CreateIndex
CREATE INDEX "VenueSubscription_currentPeriodEnd_idx" ON "VenueSubscription"("currentPeriodEnd");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_venueId_paidAt_idx" ON "SubscriptionPayment"("venueId", "paidAt");

-- AddForeignKey
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueSubscription" ADD CONSTRAINT "VenueSubscription_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "VenueSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing venues get a subscription so the owner card and the admin renewals list are never empty.
-- 90 days from this deploy; the admin adjusts each one when the real terms are agreed.
INSERT INTO "VenueSubscription" ("id", "venueId", "currentPeriodEnd", "updatedAt")
SELECT gen_random_uuid()::text, v."id", CURRENT_TIMESTAMP + INTERVAL '90 days', CURRENT_TIMESTAMP
FROM "Venue" v
WHERE NOT EXISTS (SELECT 1 FROM "VenueSubscription" s WHERE s."venueId" = v."id");

