-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('player', 'owner', 'staff', 'admin');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended', 'banned');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('login', 'register', 'reset_password', 'verify_phone');

-- CreateEnum
CREATE TYPE "SkillTier" AS ENUM ('bronze', 'silver', 'gold', 'platinum', 'legend');

-- CreateEnum
CREATE TYPE "VenueStatus" AS ENUM ('pending', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('held', 'confirmed', 'cancelled', 'completed', 'no_show');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('card', 'wallet', 'fawry', 'instapay', 'cash');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'paid', 'failed', 'refunded', 'partial');

-- CreateEnum
CREATE TYPE "SplitShareStatus" AS ENUM ('pending', 'paid', 'released');

-- CreateEnum
CREATE TYPE "FriendshipStatus" AS ENUM ('pending', 'accepted', 'declined', 'blocked');

-- CreateEnum
CREATE TYPE "MatchPostStatus" AS ENUM ('open', 'full', 'played', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "JoinRequestStatus" AS ENUM ('pending', 'approved', 'declined');

-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('pending', 'accepted', 'declined', 'played');

-- CreateEnum
CREATE TYPE "ChatThreadType" AS ENUM ('direct', 'match', 'team');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('text', 'image', 'voice', 'system');

-- CreateEnum
CREATE TYPE "MessageDelivery" AS ENUM ('sent', 'delivered', 'read');

-- CreateEnum
CREATE TYPE "SquadInviteStatus" AS ENUM ('pending', 'accepted', 'declined', 'expired');

-- CreateEnum
CREATE TYPE "PromoType" AS ENUM ('percentage', 'fixed_amount');

-- CreateEnum
CREATE TYPE "PulseWindow" AS ENUM ('now', 'tonight', 'weekend');

-- CreateEnum
CREATE TYPE "PulseMode" AS ENUM ('casual', 'competitive');

-- CreateEnum
CREATE TYPE "PulseOpportunityKind" AS ENUM ('rescue', 'micro_lobby', 'friend_ready', 'venue_drop');

-- CreateEnum
CREATE TYPE "PulseOpportunityStatus" AS ENUM ('open', 'held', 'claimed', 'full', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "PulseClaimState" AS ENUM ('held', 'confirmed', 'released', 'expired');

-- CreateEnum
CREATE TYPE "StaffInviteStatus" AS ENUM ('pending', 'accepted', 'declined', 'revoked');

-- CreateEnum
CREATE TYPE "ReportEntityType" AS ENUM ('post', 'review', 'chat', 'player', 'venue');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('open', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "avatarConfig" JSONB,
    "roles" "UserRole"[] DEFAULT ARRAY['player']::"UserRole"[],
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "preferredLang" TEXT NOT NULL DEFAULT 'ar',
    "reputation" INTEGER NOT NULL DEFAULT 0,
    "reliabilityPct" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "coinsBalance" INTEGER NOT NULL DEFAULT 0,
    "streakCount" INTEGER NOT NULL DEFAULT 0,
    "streakUpdatedAt" TIMESTAMP(3),
    "referralCode" TEXT NOT NULL,
    "referredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "deviceInfo" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "target" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "descriptionAr" TEXT,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "UserRoleAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "venueId" TEXT,

    CONSTRAINT "UserRoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CountryConfig" (
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "phoneCallingCode" TEXT NOT NULL,
    "weekendDays" INTEGER[] DEFAULT ARRAY[5, 6]::INTEGER[],
    "paymentMethods" TEXT[],

    CONSTRAINT "CountryConfig_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Governorate" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,

    CONSTRAINT "Governorate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "District" (
    "id" TEXT NOT NULL,
    "governorateId" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,

    CONSTRAINT "District_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SportCategory" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "accentColor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SportCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSportSkill" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sportId" TEXT NOT NULL,
    "tier" "SkillTier" NOT NULL DEFAULT 'bronze',
    "eloScore" INTEGER NOT NULL DEFAULT 1000,
    "position" TEXT,

    CONSTRAINT "UserSportSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Amenity" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "icon" TEXT NOT NULL,

    CONSTRAINT "Amenity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "descriptionAr" TEXT,
    "governorateId" TEXT,
    "districtId" TEXT,
    "address" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "geohash" TEXT NOT NULL,
    "surface" TEXT,
    "instantBook" BOOLEAN NOT NULL DEFAULT true,
    "cancellationPolicy" TEXT,
    "status" "VenueStatus" NOT NULL DEFAULT 'pending',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueSport" (
    "venueId" TEXT NOT NULL,
    "sportId" TEXT NOT NULL,

    CONSTRAINT "VenueSport_pkey" PRIMARY KEY ("venueId","sportId")
);

-- CreateTable
CREATE TABLE "VenueAmenity" (
    "venueId" TEXT NOT NULL,
    "amenityId" TEXT NOT NULL,

    CONSTRAINT "VenueAmenity_pkey" PRIMARY KEY ("venueId","amenityId")
);

-- CreateTable
CREATE TABLE "VenuePhoto" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "VenuePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Court" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "sportId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "surface" TEXT,
    "indoor" BOOLEAN NOT NULL DEFAULT false,
    "format" TEXT,
    "slotDurationMins" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Court_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "courtId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "daysOfWeek" INTEGER[],
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "priceAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "courtId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slotStart" TIMESTAMP(3) NOT NULL,
    "slotEnd" TIMESTAMP(3) NOT NULL,
    "baseAmount" INTEGER NOT NULL,
    "feeAmount" INTEGER NOT NULL DEFAULT 0,
    "discountAmount" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "promoCodeId" TEXT,
    "coinsRedeemed" INTEGER NOT NULL DEFAULT 0,
    "paymentMethod" "PaymentMethod",
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "status" "BookingStatus" NOT NULL DEFAULT 'held',
    "holdExpiresAt" TIMESTAMP(3),
    "isSplitPayment" BOOLEAN NOT NULL DEFAULT false,
    "qrPayload" TEXT,
    "checkedInAt" TIMESTAMP(3),
    "checkedInByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "recurringSeriesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingSplitShare" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT,
    "phone" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "status" "SplitShareStatus" NOT NULL DEFAULT 'pending',
    "shareLinkToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingSplitShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringBookingSeries" (
    "id" TEXT NOT NULL,
    "courtId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationMins" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringBookingSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueReview" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "tags" TEXT[],
    "text" TEXT,
    "photos" TEXT[],
    "ownerReply" TEXT,
    "ownerRepliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerRating" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "raterId" TEXT NOT NULL,
    "rateeId" TEXT NOT NULL,
    "sportsmanship" INTEGER NOT NULL,
    "skill" INTEGER NOT NULL,
    "punctuality" INTEGER NOT NULL,
    "mvpVote" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Friendship" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "addresseeId" TEXT NOT NULL,
    "status" "FriendshipStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchPost" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "sportId" TEXT NOT NULL,
    "venueId" TEXT,
    "courtId" TEXT,
    "districtId" TEXT,
    "dateTime" TIMESTAMP(3) NOT NULL,
    "playersNeeded" INTEGER NOT NULL,
    "skillTier" "SkillTier",
    "costPerPlayerAmount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "notes" TEXT,
    "chatThreadId" TEXT,
    "status" "MatchPostStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchPostJoinRequest" (
    "id" TEXT NOT NULL,
    "matchPostId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "JoinRequestStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchPostJoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "captainId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("teamId","userId")
);

-- CreateTable
CREATE TABLE "TeamChallenge" (
    "id" TEXT NOT NULL,
    "challengerTeamId" TEXT NOT NULL,
    "challengedTeamId" TEXT NOT NULL,
    "status" "ChallengeStatus" NOT NULL DEFAULT 'pending',
    "proposedDateTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatThread" (
    "id" TEXT NOT NULL,
    "type" "ChatThreadType" NOT NULL,
    "pairKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatThreadParticipant" (
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastReadMessageId" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatThreadParticipant_pkey" PRIMARY KEY ("threadId","userId")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "clientMessageId" TEXT,
    "senderId" TEXT NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'text',
    "text" TEXT,
    "attachmentUrl" TEXT,
    "attachmentMime" TEXT,
    "attachmentSize" INTEGER,
    "delivery" "MessageDelivery" NOT NULL DEFAULT 'sent',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "bodyEn" TEXT,
    "bodyAr" TEXT,
    "deepLink" TEXT,
    "payload" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Squad" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Squad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquadMember" (
    "id" TEXT NOT NULL,
    "squadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isLeader" BOOLEAN NOT NULL DEFAULT false,
    "micMuted" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquadMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquadInvite" (
    "id" TEXT NOT NULL,
    "squadId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "status" "SquadInviteStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquadInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquadJoinRequest" (
    "id" TEXT NOT NULL,
    "squadId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "viaMemberId" TEXT,
    "status" "SquadInviteStatus" NOT NULL DEFAULT 'pending',
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquadJoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinLedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "bookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quest" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "rule" JSONB NOT NULL,
    "rewardCoins" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserQuestProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questId" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "target" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3),
    "weekKey" TEXT NOT NULL,

    CONSTRAINT "UserQuestProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Badge" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "descriptionAr" TEXT,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBadge" (
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("userId","badgeId")
);

-- CreateTable
CREATE TABLE "PromoCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "PromoType" NOT NULL,
    "value" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "sportId" TEXT,
    "venueId" TEXT,
    "firstBookingOnly" BOOLEAN NOT NULL DEFAULT false,
    "offPeakOnly" BOOLEAN NOT NULL DEFAULT false,
    "minBookingAmount" INTEGER,
    "usageLimitTotal" INTEGER,
    "usageLimitPerUser" INTEGER NOT NULL DEFAULT 1,
    "stackableWithCoins" BOOLEAN NOT NULL DEFAULT true,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoRedemption" (
    "id" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PulseAvailability" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "window" "PulseWindow" NOT NULL,
    "sportId" TEXT NOT NULL,
    "mode" "PulseMode" NOT NULL,
    "radiusKm" DOUBLE PRECISION NOT NULL,
    "maxBudgetAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "districtId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PulseAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PulseOpportunity" (
    "id" TEXT NOT NULL,
    "kind" "PulseOpportunityKind" NOT NULL,
    "status" "PulseOpportunityStatus" NOT NULL DEFAULT 'open',
    "sportId" TEXT NOT NULL,
    "mode" "PulseMode" NOT NULL,
    "skillTier" "SkillTier",
    "organizerUserId" TEXT,
    "matchPostId" TEXT,
    "bookingId" TEXT,
    "districtId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "costPerPlayerAmount" INTEGER NOT NULL,
    "originalCostPerPlayerAmount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "capacity" INTEGER NOT NULL,
    "reliabilityFloor" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PulseOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PulseClaim" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" "PulseClaimState" NOT NULL DEFAULT 'held',
    "holdExpiresAt" TIMESTAMP(3),
    "bookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PulseClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionSetting" (
    "id" TEXT NOT NULL,
    "venueId" TEXT,
    "percentageBps" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffInvite" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "inviteePhone" TEXT NOT NULL,
    "inviteeUserId" TEXT,
    "roleId" TEXT,
    "status" "StaffInviteStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLogEntry" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "serviceFeePct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "coinsPerHundredEgp" INTEGER NOT NULL DEFAULT 10,
    "coinToEgpRate" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationReport" (
    "id" TEXT NOT NULL,
    "entityType" "ReportEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reportedUserId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'open',
    "reviewedById" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlogCategory" (
    "id" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,

    CONSTRAINT "BlogCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlogPost" (
    "id" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "subtitleEn" TEXT,
    "subtitleAr" TEXT,
    "coverImageUrl" TEXT,
    "contentEn" TEXT NOT NULL,
    "contentAr" TEXT NOT NULL,
    "categoryId" TEXT,
    "authorId" TEXT,
    "status" "PublishStatus" NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlogPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Banner" (
    "id" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "linkUrl" TEXT,
    "placement" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Banner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaqEntry" (
    "id" TEXT NOT NULL,
    "questionEn" TEXT NOT NULL,
    "questionAr" TEXT NOT NULL,
    "answerEn" TEXT NOT NULL,
    "answerAr" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FaqEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportInquiry" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "userId" TEXT,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "SupportInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "responseBody" JSONB,
    "statusCode" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "OtpCode_target_purpose_idx" ON "OtpCode"("target", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE INDEX "Role_ownerId_idx" ON "Role"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRoleAssignment_userId_roleId_venueId_key" ON "UserRoleAssignment"("userId", "roleId", "venueId");

-- CreateIndex
CREATE INDEX "Governorate_countryCode_idx" ON "Governorate"("countryCode");

-- CreateIndex
CREATE INDEX "District_governorateId_idx" ON "District"("governorateId");

-- CreateIndex
CREATE UNIQUE INDEX "SportCategory_slug_key" ON "SportCategory"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "UserSportSkill_userId_sportId_key" ON "UserSportSkill"("userId", "sportId");

-- CreateIndex
CREATE UNIQUE INDEX "Amenity_key_key" ON "Amenity"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Venue_slug_key" ON "Venue"("slug");

-- CreateIndex
CREATE INDEX "Venue_geohash_idx" ON "Venue"("geohash");

-- CreateIndex
CREATE INDEX "Venue_lat_lng_idx" ON "Venue"("lat", "lng");

-- CreateIndex
CREATE INDEX "Venue_status_idx" ON "Venue"("status");

-- CreateIndex
CREATE INDEX "VenuePhoto_venueId_idx" ON "VenuePhoto"("venueId");

-- CreateIndex
CREATE INDEX "Court_venueId_idx" ON "Court"("venueId");

-- CreateIndex
CREATE INDEX "PricingRule_courtId_idx" ON "PricingRule"("courtId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_code_key" ON "Booking"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_qrPayload_key" ON "Booking"("qrPayload");

-- CreateIndex
CREATE INDEX "Booking_courtId_slotStart_idx" ON "Booking"("courtId", "slotStart");

-- CreateIndex
CREATE INDEX "Booking_userId_idx" ON "Booking"("userId");

-- CreateIndex
CREATE INDEX "Booking_status_idx" ON "Booking"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BookingSplitShare_shareLinkToken_key" ON "BookingSplitShare"("shareLinkToken");

-- CreateIndex
CREATE INDEX "BookingSplitShare_bookingId_idx" ON "BookingSplitShare"("bookingId");

-- CreateIndex
CREATE INDEX "Payment_bookingId_idx" ON "Payment"("bookingId");

-- CreateIndex
CREATE INDEX "RecurringBookingSeries_userId_idx" ON "RecurringBookingSeries"("userId");

-- CreateIndex
CREATE INDEX "VenueReview_venueId_idx" ON "VenueReview"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueReview_bookingId_userId_key" ON "VenueReview"("bookingId", "userId");

-- CreateIndex
CREATE INDEX "PlayerRating_rateeId_idx" ON "PlayerRating"("rateeId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerRating_bookingId_raterId_rateeId_key" ON "PlayerRating"("bookingId", "raterId", "rateeId");

-- CreateIndex
CREATE INDEX "Friendship_addresseeId_status_idx" ON "Friendship"("addresseeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Friendship_requesterId_addresseeId_key" ON "Friendship"("requesterId", "addresseeId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchPost_chatThreadId_key" ON "MatchPost"("chatThreadId");

-- CreateIndex
CREATE INDEX "MatchPost_sportId_status_idx" ON "MatchPost"("sportId", "status");

-- CreateIndex
CREATE INDEX "MatchPost_districtId_idx" ON "MatchPost"("districtId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchPostJoinRequest_matchPostId_userId_key" ON "MatchPostJoinRequest"("matchPostId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatThread_pairKey_key" ON "ChatThread"("pairKey");

-- CreateIndex
CREATE INDEX "ChatThread_type_idx" ON "ChatThread"("type");

-- CreateIndex
CREATE INDEX "ChatMessage_threadId_createdAt_idx" ON "ChatMessage"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_threadId_clientMessageId_key" ON "ChatMessage"("threadId", "clientMessageId");

-- CreateIndex
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE UNIQUE INDEX "SquadMember_squadId_userId_key" ON "SquadMember"("squadId", "userId");

-- CreateIndex
CREATE INDEX "CoinLedgerEntry_userId_createdAt_idx" ON "CoinLedgerEntry"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quest_key_key" ON "Quest"("key");

-- CreateIndex
CREATE UNIQUE INDEX "UserQuestProgress_userId_questId_weekKey_key" ON "UserQuestProgress"("userId", "questId", "weekKey");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_key_key" ON "Badge"("key");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_code_key" ON "PromoCode"("code");

-- CreateIndex
CREATE INDEX "PromoCode_code_idx" ON "PromoCode"("code");

-- CreateIndex
CREATE INDEX "PromoRedemption_promoCodeId_userId_idx" ON "PromoRedemption"("promoCodeId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PulseAvailability_userId_key" ON "PulseAvailability"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PulseOpportunity_bookingId_key" ON "PulseOpportunity"("bookingId");

-- CreateIndex
CREATE INDEX "PulseOpportunity_status_sportId_idx" ON "PulseOpportunity"("status", "sportId");

-- CreateIndex
CREATE UNIQUE INDEX "PulseClaim_opportunityId_userId_key" ON "PulseClaim"("opportunityId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionSetting_venueId_key" ON "CommissionSetting"("venueId");

-- CreateIndex
CREATE INDEX "Payout_venueId_idx" ON "Payout"("venueId");

-- CreateIndex
CREATE INDEX "StaffInvite_venueId_idx" ON "StaffInvite"("venueId");

-- CreateIndex
CREATE INDEX "AuditLogEntry_actorUserId_createdAt_idx" ON "AuditLogEntry"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationReport_status_idx" ON "ModerationReport"("status");

-- CreateIndex
CREATE INDEX "BlogPost_status_idx" ON "BlogPost"("status");

-- CreateIndex
CREATE INDEX "IdempotencyKey_userId_idx" ON "IdempotencyKey"("userId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtpCode" ADD CONSTRAINT "OtpCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Governorate" ADD CONSTRAINT "Governorate_countryCode_fkey" FOREIGN KEY ("countryCode") REFERENCES "CountryConfig"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "District" ADD CONSTRAINT "District_governorateId_fkey" FOREIGN KEY ("governorateId") REFERENCES "Governorate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSportSkill" ADD CONSTRAINT "UserSportSkill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSportSkill" ADD CONSTRAINT "UserSportSkill_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "SportCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_governorateId_fkey" FOREIGN KEY ("governorateId") REFERENCES "Governorate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueSport" ADD CONSTRAINT "VenueSport_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueSport" ADD CONSTRAINT "VenueSport_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "SportCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueAmenity" ADD CONSTRAINT "VenueAmenity_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueAmenity" ADD CONSTRAINT "VenueAmenity_amenityId_fkey" FOREIGN KEY ("amenityId") REFERENCES "Amenity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenuePhoto" ADD CONSTRAINT "VenuePhoto_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Court" ADD CONSTRAINT "Court_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Court" ADD CONSTRAINT "Court_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "SportCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_recurringSeriesId_fkey" FOREIGN KEY ("recurringSeriesId") REFERENCES "RecurringBookingSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSplitShare" ADD CONSTRAINT "BookingSplitShare_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingSplitShare" ADD CONSTRAINT "BookingSplitShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBookingSeries" ADD CONSTRAINT "RecurringBookingSeries_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBookingSeries" ADD CONSTRAINT "RecurringBookingSeries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueReview" ADD CONSTRAINT "VenueReview_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueReview" ADD CONSTRAINT "VenueReview_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueReview" ADD CONSTRAINT "VenueReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerRating" ADD CONSTRAINT "PlayerRating_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerRating" ADD CONSTRAINT "PlayerRating_raterId_fkey" FOREIGN KEY ("raterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerRating" ADD CONSTRAINT "PlayerRating_rateeId_fkey" FOREIGN KEY ("rateeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchPost" ADD CONSTRAINT "MatchPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchPost" ADD CONSTRAINT "MatchPost_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "SportCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchPost" ADD CONSTRAINT "MatchPost_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchPost" ADD CONSTRAINT "MatchPost_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchPost" ADD CONSTRAINT "MatchPost_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchPost" ADD CONSTRAINT "MatchPost_chatThreadId_fkey" FOREIGN KEY ("chatThreadId") REFERENCES "ChatThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchPostJoinRequest" ADD CONSTRAINT "MatchPostJoinRequest_matchPostId_fkey" FOREIGN KEY ("matchPostId") REFERENCES "MatchPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchPostJoinRequest" ADD CONSTRAINT "MatchPostJoinRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_captainId_fkey" FOREIGN KEY ("captainId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChallenge" ADD CONSTRAINT "TeamChallenge_challengerTeamId_fkey" FOREIGN KEY ("challengerTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChallenge" ADD CONSTRAINT "TeamChallenge_challengedTeamId_fkey" FOREIGN KEY ("challengedTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThreadParticipant" ADD CONSTRAINT "ChatThreadParticipant_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThreadParticipant" ADD CONSTRAINT "ChatThreadParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadMember" ADD CONSTRAINT "SquadMember_squadId_fkey" FOREIGN KEY ("squadId") REFERENCES "Squad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadMember" ADD CONSTRAINT "SquadMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadInvite" ADD CONSTRAINT "SquadInvite_squadId_fkey" FOREIGN KEY ("squadId") REFERENCES "Squad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadInvite" ADD CONSTRAINT "SquadInvite_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadInvite" ADD CONSTRAINT "SquadInvite_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadJoinRequest" ADD CONSTRAINT "SquadJoinRequest_squadId_fkey" FOREIGN KEY ("squadId") REFERENCES "Squad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadJoinRequest" ADD CONSTRAINT "SquadJoinRequest_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadJoinRequest" ADD CONSTRAINT "SquadJoinRequest_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinLedgerEntry" ADD CONSTRAINT "CoinLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinLedgerEntry" ADD CONSTRAINT "CoinLedgerEntry_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserQuestProgress" ADD CONSTRAINT "UserQuestProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserQuestProgress" ADD CONSTRAINT "UserQuestProgress_questId_fkey" FOREIGN KEY ("questId") REFERENCES "Quest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "SportCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseAvailability" ADD CONSTRAINT "PulseAvailability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseAvailability" ADD CONSTRAINT "PulseAvailability_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "SportCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseOpportunity" ADD CONSTRAINT "PulseOpportunity_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "SportCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseOpportunity" ADD CONSTRAINT "PulseOpportunity_organizerUserId_fkey" FOREIGN KEY ("organizerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseOpportunity" ADD CONSTRAINT "PulseOpportunity_matchPostId_fkey" FOREIGN KEY ("matchPostId") REFERENCES "MatchPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseOpportunity" ADD CONSTRAINT "PulseOpportunity_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseClaim" ADD CONSTRAINT "PulseClaim_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "PulseOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseClaim" ADD CONSTRAINT "PulseClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseClaim" ADD CONSTRAINT "PulseClaim_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionSetting" ADD CONSTRAINT "CommissionSetting_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffInvite" ADD CONSTRAINT "StaffInvite_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffInvite" ADD CONSTRAINT "StaffInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffInvite" ADD CONSTRAINT "StaffInvite_inviteeUserId_fkey" FOREIGN KEY ("inviteeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_reportedUserId_fkey" FOREIGN KEY ("reportedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "BlogCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportInquiry" ADD CONSTRAINT "SupportInquiry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
