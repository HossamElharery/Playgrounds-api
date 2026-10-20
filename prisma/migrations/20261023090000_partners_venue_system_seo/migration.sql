-- /partners now sells the venue-management system. Move its marketing SEO to the new copy
-- (web: HUB_SEO in partners-landing.content.ts), but only while it still holds the copy seeded
-- by 20260914054800_content_seo_copy, so an admin's own edit is never overwritten.
UPDATE "PageSeoOverride"
SET
  "titleAr" = 'سيستم حجز وإدارة الملاعب في مصر | ماتشنا',
  "titleEn" = 'Sports Venue Booking & Management System | Matchena',
  "descriptionAr" = 'سيستم لملاعب الكورة والبادل وصالات البلايستيشن: حجوزات أونلاين، جدول، خزنة وشيفتات، موظفين وتقارير ربح. جرّب 30 يوم مجانًا.',
  "descriptionEn" = 'Booking and management software for football, padel and gaming venues: online bookings, cash shifts, staff and profit reports. 30-day free trial.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'partners'
  AND "titleAr" = 'شركاء ماتشنا | أدر المواعيد واستقبل الحجوزات'
  AND "titleEn" = 'Matchena Partners | List your courts';
