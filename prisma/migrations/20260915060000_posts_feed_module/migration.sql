-- Posts & media feed module. Additive only.

ALTER TABLE "PlatformSetting" ADD COLUMN IF NOT EXISTS "autoHideReportThreshold" INTEGER NOT NULL DEFAULT 5;

CREATE TYPE "PostAuthorKind" AS ENUM ('user', 'official', 'venue');
CREATE TYPE "PostStatus" AS ENUM ('active', 'removed');
CREATE TYPE "PostMediaType" AS ENUM ('image', 'video');
CREATE TYPE "PostReportReason" AS ENUM ('spam', 'inappropriate', 'copyright', 'harassment', 'misinformation', 'other');
CREATE TYPE "PostReportStatus" AS ENUM ('open', 'reviewed', 'dismissed');
CREATE TYPE "ModerationActionType" AS ENUM ('post_deleted', 'comment_deleted', 'user_posting_suspended', 'user_posting_unsuspended', 'report_dismissed');
CREATE TYPE "MediaAssetStatus" AS ENUM ('pending', 'ready', 'failed');

CREATE TABLE "MediaAsset" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "PostMediaType" NOT NULL,
  "key" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "thumbnailUrl" TEXT,
  "mimeType" TEXT NOT NULL,
  "width" INTEGER NOT NULL DEFAULT 0,
  "height" INTEGER NOT NULL DEFAULT 0,
  "durationSeconds" INTEGER,
  "altText" TEXT,
  "status" "MediaAssetStatus" NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Post" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "authorKind" "PostAuthorKind" NOT NULL DEFAULT 'user',
  "text" TEXT NOT NULL,
  "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "taggedVenueId" TEXT,
  "linkedMatchId" TEXT,
  "visibility" TEXT NOT NULL DEFAULT 'public',
  "status" "PostStatus" NOT NULL DEFAULT 'active',
  "autoHidden" BOOLEAN NOT NULL DEFAULT false,
  "flagged" BOOLEAN NOT NULL DEFAULT false,
  "removedReason" TEXT,
  "removedByAdminId" TEXT,
  "likeCount" INTEGER NOT NULL DEFAULT 0,
  "commentCount" INTEGER NOT NULL DEFAULT 0,
  "shareCount" INTEGER NOT NULL DEFAULT 0,
  "saveCount" INTEGER NOT NULL DEFAULT 0,
  "coinsAwarded" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PostMedia" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "assetId" TEXT,
  "type" "PostMediaType" NOT NULL,
  "url" TEXT NOT NULL,
  "thumbnailUrl" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "durationSeconds" INTEGER,
  "order" INTEGER NOT NULL DEFAULT 0,
  "altText" TEXT,
  CONSTRAINT "PostMedia_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PostComment" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "parentCommentId" TEXT,
  "text" TEXT NOT NULL,
  "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status" "PostStatus" NOT NULL DEFAULT 'active',
  "removedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PostComment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PostLike" (
  "postId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PostLike_pkey" PRIMARY KEY ("postId","userId")
);

CREATE TABLE "PostSave" (
  "postId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PostSave_pkey" PRIMARY KEY ("postId","userId")
);

CREATE TABLE "PostShare" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "channel" TEXT NOT NULL DEFAULT 'internal',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PostShare_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Follow" (
  "followerId" TEXT NOT NULL,
  "followingId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Follow_pkey" PRIMARY KEY ("followerId","followingId")
);

CREATE TABLE "Hashtag" (
  "tag" TEXT NOT NULL,
  "postCount" INTEGER NOT NULL DEFAULT 0,
  "trendingScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Hashtag_pkey" PRIMARY KEY ("tag")
);

CREATE TABLE "PostReport" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "reportedByUserId" TEXT NOT NULL,
  "reason" "PostReportReason" NOT NULL,
  "note" TEXT,
  "status" "PostReportStatus" NOT NULL DEFAULT 'open',
  "reviewedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PostReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModerationAction" (
  "id" TEXT NOT NULL,
  "type" "ModerationActionType" NOT NULL,
  "targetPostId" TEXT,
  "targetCommentId" TEXT,
  "targetUserId" TEXT,
  "reason" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserPostingRestriction" (
  "userId" TEXT NOT NULL,
  "suspendedUntil" TIMESTAMP(3),
  "permanent" BOOLEAN NOT NULL DEFAULT false,
  "reason" TEXT NOT NULL,
  "issuedByAdminId" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserPostingRestriction_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "CoinsRewardRule" (
  "id" TEXT NOT NULL,
  "metric" TEXT NOT NULL DEFAULT 'like_count',
  "threshold" INTEGER NOT NULL DEFAULT 200,
  "coinsAwarded" INTEGER NOT NULL DEFAULT 150,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "updatedByAdminId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CoinsRewardRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalyticsEvent" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "userId" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MediaAsset_userId_createdAt_idx" ON "MediaAsset"("userId", "createdAt");
CREATE INDEX "Post_status_createdAt_idx" ON "Post"("status", "createdAt");
CREATE INDEX "Post_authorId_createdAt_idx" ON "Post"("authorId", "createdAt");
CREATE INDEX "Post_taggedVenueId_createdAt_idx" ON "Post"("taggedVenueId", "createdAt");
CREATE INDEX "Post_linkedMatchId_idx" ON "Post"("linkedMatchId");
CREATE INDEX "Post_slug_idx" ON "Post"("slug");
CREATE INDEX "Post_hashtags_idx" ON "Post" USING GIN ("hashtags");
CREATE INDEX "PostMedia_postId_order_idx" ON "PostMedia"("postId", "order");
CREATE INDEX "PostComment_postId_createdAt_idx" ON "PostComment"("postId", "createdAt");
CREATE INDEX "PostComment_parentCommentId_idx" ON "PostComment"("parentCommentId");
CREATE INDEX "PostLike_userId_createdAt_idx" ON "PostLike"("userId", "createdAt");
CREATE INDEX "PostSave_userId_createdAt_idx" ON "PostSave"("userId", "createdAt");
CREATE INDEX "PostShare_postId_createdAt_idx" ON "PostShare"("postId", "createdAt");
CREATE INDEX "Follow_followingId_createdAt_idx" ON "Follow"("followingId", "createdAt");
CREATE INDEX "Follow_followerId_createdAt_idx" ON "Follow"("followerId", "createdAt");
CREATE UNIQUE INDEX "PostReport_postId_reportedByUserId_key" ON "PostReport"("postId", "reportedByUserId");
CREATE INDEX "PostReport_status_createdAt_idx" ON "PostReport"("status", "createdAt");
CREATE INDEX "ModerationAction_createdAt_idx" ON "ModerationAction"("createdAt");
CREATE INDEX "ModerationAction_targetPostId_idx" ON "ModerationAction"("targetPostId");
CREATE INDEX "ModerationAction_targetUserId_idx" ON "ModerationAction"("targetUserId");
CREATE INDEX "AnalyticsEvent_name_createdAt_idx" ON "AnalyticsEvent"("name", "createdAt");

ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON UPDATE CASCADE;
ALTER TABLE "Post" ADD CONSTRAINT "Post_removedByAdminId_fkey" FOREIGN KEY ("removedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Post" ADD CONSTRAINT "Post_taggedVenueId_fkey" FOREIGN KEY ("taggedVenueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Post" ADD CONSTRAINT "Post_linkedMatchId_fkey" FOREIGN KEY ("linkedMatchId") REFERENCES "MatchPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON UPDATE CASCADE;
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_parentCommentId_fkey" FOREIGN KEY ("parentCommentId") REFERENCES "PostComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PostLike" ADD CONSTRAINT "PostLike_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostLike" ADD CONSTRAINT "PostLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostSave" ADD CONSTRAINT "PostSave_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostSave" ADD CONSTRAINT "PostSave_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostShare" ADD CONSTRAINT "PostShare_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostShare" ADD CONSTRAINT "PostShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostReport" ADD CONSTRAINT "PostReport_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostReport" ADD CONSTRAINT "PostReport_reportedByUserId_fkey" FOREIGN KEY ("reportedByUserId") REFERENCES "User"("id") ON UPDATE CASCADE;
ALTER TABLE "PostReport" ADD CONSTRAINT "PostReport_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON UPDATE CASCADE;
ALTER TABLE "UserPostingRestriction" ADD CONSTRAINT "UserPostingRestriction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoinsRewardRule" ADD CONSTRAINT "CoinsRewardRule_updatedByAdminId_fkey" FOREIGN KEY ("updatedByAdminId") REFERENCES "User"("id") ON UPDATE CASCADE;
