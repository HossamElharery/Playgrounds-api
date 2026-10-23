-- Coins hardening: engagement coins wait in CoinGrant until the player is
-- "trusted" (a paid booking checked in at a venue), plus lifetime achievements.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "trustedAt" TIMESTAMP(3);

-- Players who already completed a paid, checked-in platform booking are trusted.
UPDATE "User" u
SET "trustedAt" = b.first_checkin
FROM (
  SELECT "userId", MIN("checkedInAt") AS first_checkin
  FROM "Booking"
  WHERE "status" = 'completed' AND "checkedInAt" IS NOT NULL
    AND "source" = 'platform' AND "totalAmount" >= 5000
  GROUP BY "userId"
) b
WHERE u."id" = b."userId" AND u."trustedAt" IS NULL;

CREATE TABLE IF NOT EXISTS "CoinGrant" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "refKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requiresTrust" BOOLEAN NOT NULL DEFAULT true,
  "dailyCapped" BOOLEAN NOT NULL DEFAULT false,
  "releaseAt" TIMESTAMP(3),
  "bookingId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "CoinGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CoinGrant_userId_refKey_key" ON "CoinGrant"("userId", "refKey");
CREATE INDEX IF NOT EXISTS "CoinGrant_status_releaseAt_idx" ON "CoinGrant"("status", "releaseAt");
CREATE INDEX IF NOT EXISTS "CoinGrant_userId_status_idx" ON "CoinGrant"("userId", "status");
ALTER TABLE "CoinGrant" ADD CONSTRAINT "CoinGrant_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "UserMetric" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "value" INTEGER NOT NULL DEFAULT 0,
  "dayKey" TEXT,
  "dayCount" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserMetric_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserMetric_userId_metric_key" ON "UserMetric"("userId", "metric");
ALTER TABLE "UserMetric" ADD CONSTRAINT "UserMetric_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "Achievement" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "target" INTEGER NOT NULL,
  "rewardCoins" INTEGER NOT NULL,
  "titleEn" TEXT NOT NULL,
  "titleAr" TEXT NOT NULL,
  "descEn" TEXT NOT NULL DEFAULT '',
  "descAr" TEXT NOT NULL DEFAULT '',
  "icon" TEXT,
  "category" TEXT NOT NULL DEFAULT 'games',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Achievement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Achievement_key_key" ON "Achievement"("key");
CREATE INDEX IF NOT EXISTS "Achievement_metric_active_idx" ON "Achievement"("metric", "active");

CREATE TABLE IF NOT EXISTS "UserAchievement" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "achievementId" TEXT NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserAchievement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserAchievement_userId_achievementId_key" ON "UserAchievement"("userId", "achievementId");
ALTER TABLE "UserAchievement" ADD CONSTRAINT "UserAchievement_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserAchievement" ADD CONSTRAINT "UserAchievement_achievementId_fkey"
  FOREIGN KEY ("achievementId") REFERENCES "Achievement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- "Leave a review with a photo" used to be bumped by any review.
UPDATE "Quest" SET "rule" = jsonb_set("rule", '{event}', '"review.photo"')
WHERE "key" = 'weekly_review_with_photo' AND "rule"->>'event' = 'review.submitted';

INSERT INTO "Achievement"
  ("id", "key", "metric", "target", "rewardCoins", "titleEn", "titleAr", "descEn", "descAr", "icon", "category", "sortOrder")
VALUES
  ('ach-penalties_win_10', 'penalties_win_10', 'game.win.penalties', 10, 80, 'Penalty Sniper', 'قناص ضربات الجزاء', 'Win 10 penalty shootouts against real players', 'اكسب 10 ماتشات ضربات جزاء ضد لاعبين حقيقيين', 'target', 'games', 10),
  ('ach-penalties_win_50', 'penalties_win_50', 'game.win.penalties', 50, 250, 'Penalty Legend', 'أسطورة ضربات الجزاء', 'Win 50 penalty shootouts against real players', 'اكسب 50 ماتش ضربات جزاء ضد لاعبين حقيقيين', 'trophy', 'games', 20),
  ('ach-thief_win_10', 'thief_win_10', 'game.win.thief', 10, 80, 'Master Thief', 'حرامي محترف', 'Win 10 rounds of Ball Thief against real players', 'اكسب 10 جولات من حرامي الكورة ضد لاعبين حقيقيين', 'target', 'games', 30),
  ('ach-thief_win_50', 'thief_win_50', 'game.win.thief', 50, 250, 'Thief Legend', 'أسطورة حرامي الكورة', 'Win 50 rounds of Ball Thief against real players', 'اكسب 50 جولة من حرامي الكورة ضد لاعبين حقيقيين', 'trophy', 'games', 40),
  ('ach-camo_win_10', 'camo_win_10', 'game.win.camo', 10, 80, 'Camo Champion', 'بطل الاستغماية', 'Win 10 hide-and-seek matches against real players', 'اكسب 10 ماتشات استغماية ضد لاعبين حقيقيين', 'target', 'games', 50),
  ('ach-camo_win_50', 'camo_win_50', 'game.win.camo', 50, 250, 'Camo Legend', 'أسطورة الاستغماية', 'Win 50 hide-and-seek matches against real players', 'اكسب 50 ماتش استغماية ضد لاعبين حقيقيين', 'trophy', 'games', 60),
  ('ach-games_win_25', 'games_win_25', 'game.win', 25, 120, 'All-round Champion', 'بطل الألعاب', 'Win 25 lobby games in total', 'اكسب 25 لعبة في اللوبي بشكل عام', 'trophy', 'games', 70),
  ('ach-games_win_100', 'games_win_100', 'game.win', 100, 400, 'Lobby King', 'ملك اللوبي', 'Win 100 lobby games in total', 'اكسب 100 لعبة في اللوبي بشكل عام', 'trophy', 'games', 80),
  ('ach-games_played_50', 'games_played_50', 'game.played', 50, 100, 'Lobby Regular', 'من أهل اللوبي', 'Play 50 lobby games with other players', 'العب 50 لعبة في اللوبي مع لاعبين تانيين', 'users', 'games', 90),
  ('ach-match_host_1', 'match_host_1', 'match.hosted', 1, 40, 'First Organizer', 'أول تنظيم', 'Host a match that was actually played', 'نظّم ماتش واتلعب فعلاً', 'calendar', 'matches', 100),
  ('ach-match_host_5', 'match_host_5', 'match.hosted', 5, 150, 'Match Maker', 'صانع ماتشات', 'Host 5 matches that were actually played', 'نظّم 5 ماتشات واتلعبوا فعلاً', 'calendar', 'matches', 110),
  ('ach-match_host_20', 'match_host_20', 'match.hosted', 20, 500, 'Community Captain', 'كابتن المجتمع', 'Host 20 matches that were actually played', 'نظّم 20 ماتش واتلعبوا فعلاً', 'trophy', 'matches', 120),
  ('ach-match_play_1', 'match_play_1', 'match.played', 1, 30, 'First Match', 'أول ماتش', 'Play a posted match at a venue', 'العب ماتش اتنشر على المنصة في ملعب', 'calendar', 'matches', 130),
  ('ach-match_play_10', 'match_play_10', 'match.played', 10, 120, 'Regular Player', 'لاعب منتظم', 'Play 10 posted matches at venues', 'العب 10 ماتشات منشورة في ملاعب', 'users', 'matches', 140),
  ('ach-match_play_50', 'match_play_50', 'match.played', 50, 500, 'Match Veteran', 'فتوة الماتشات', 'Play 50 posted matches at venues', 'العب 50 ماتش منشور في ملاعب', 'trophy', 'matches', 150),
  ('ach-bookings_5', 'bookings_5', 'booking.completed', 5, 100, 'Five Bookings', '5 حجوزات', 'Complete 5 bookings', 'كمّل 5 حجوزات', 'calendar', 'bookings', 160),
  ('ach-bookings_20', 'bookings_20', 'booking.completed', 20, 400, 'Loyal Player', 'لاعب وفي', 'Complete 20 bookings', 'كمّل 20 حجز', 'users', 'bookings', 170),
  ('ach-bookings_50', 'bookings_50', 'booking.completed', 50, 1000, 'Venue Legend', 'أسطورة الملاعب', 'Complete 50 bookings', 'كمّل 50 حجز', 'trophy', 'bookings', 180),
  ('ach-review_photo_5', 'review_photo_5', 'review.photo', 5, 100, 'Photo Reviewer', 'مقيّم بالصور', 'Leave 5 venue reviews with photos', 'اكتب 5 تقييمات لملاعب بصور', 'star', 'community', 190),
  ('ach-mvp_5', 'mvp_5', 'mvp.awarded', 5, 100, 'MVP Regular', 'نجم الماتش', 'Be voted MVP 5 times in real matches', 'اتصوّت عليك أفضل لاعب 5 مرات في ماتشات حقيقية', 'star', 'community', 200),
  ('ach-mvp_25', 'mvp_25', 'mvp.awarded', 25, 400, 'MVP Legend', 'أسطورة أفضل لاعب', 'Be voted MVP 25 times in real matches', 'اتصوّت عليك أفضل لاعب 25 مرة في ماتشات حقيقية', 'trophy', 'community', 210),
  ('ach-streak_7', 'streak_7', 'streak.best', 7, 20, 'One Week Streak', 'أسبوع متواصل', 'Open the app 7 days in a row', 'افتح التطبيق 7 أيام ورا بعض', 'flame', 'community', 220),
  ('ach-streak_30', 'streak_30', 'streak.best', 30, 80, 'Iron Streak', 'سلسلة حديد', 'Open the app 30 days in a row', 'افتح التطبيق 30 يوم ورا بعض', 'flame', 'community', 230),
  ('ach-streak_100', 'streak_100', 'streak.best', 100, 300, 'Unbreakable', 'مفيش حد بيكسرني', 'Open the app 100 days in a row', 'افتح التطبيق 100 يوم ورا بعض', 'flame', 'community', 240)
ON CONFLICT ("key") DO NOTHING;
