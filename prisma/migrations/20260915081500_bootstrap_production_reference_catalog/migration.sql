-- Production-safe reference catalog for the Egypt launch.
--
-- This migration is intentionally limited to public taxonomy/configuration.
-- It does not create demo users, venues, bookings, posts, or credentials, and
-- every statement is idempotent so existing production data is preserved.

INSERT INTO "CountryConfig" (
  "code", "nameEn", "nameAr", "currency", "phoneCallingCode", "timezone",
  "locale", "weekendDays", "paymentMethods", "serviceFeePct",
  "coinsPerHundredMajor", "coinToMajorRate", "lat", "lng", "active"
) VALUES (
  'EG', 'Egypt', 'مصر', 'EGP', '+20', 'Africa/Cairo', 'ar',
  ARRAY[5, 6],
  ARRAY['card', 'wallet', 'vodafone', 'orange', 'etisalat', 'fawry', 'instapay', 'cash'],
  5, 10, 20, 30.0444, 31.2357, true
)
ON CONFLICT ("code") DO UPDATE SET
  "nameEn" = EXCLUDED."nameEn",
  "nameAr" = EXCLUDED."nameAr",
  "currency" = EXCLUDED."currency",
  "phoneCallingCode" = EXCLUDED."phoneCallingCode",
  "timezone" = EXCLUDED."timezone",
  "locale" = EXCLUDED."locale",
  "weekendDays" = EXCLUDED."weekendDays",
  "paymentMethods" = EXCLUDED."paymentMethods",
  "lat" = EXCLUDED."lat",
  "lng" = EXCLUDED."lng",
  "active" = true;

INSERT INTO "Governorate" ("id", "countryCode", "slug", "nameEn", "nameAr") VALUES
  ('gov-cairo', 'EG', 'cairo', 'Cairo', 'القاهرة'),
  ('gov-giza', 'EG', 'giza', 'Giza', 'الجيزة')
ON CONFLICT ("id") DO UPDATE SET
  "countryCode" = EXCLUDED."countryCode",
  "slug" = EXCLUDED."slug",
  "nameEn" = EXCLUDED."nameEn",
  "nameAr" = EXCLUDED."nameAr";

INSERT INTO "District" (
  "id", "governorateId", "slug", "nameEn", "nameAr", "lat", "lng", "polygon"
) VALUES
  ('dist-nasr-city', 'gov-cairo', 'nasr-city', 'Nasr City', 'مدينة نصر', 30.0511, 31.3656,
   '{"type":"Polygon","coordinates":[[[31.34,30.04],[31.39,30.04],[31.39,30.07],[31.34,30.07],[31.34,30.04]]]}'::jsonb),
  ('dist-maadi', 'gov-cairo', 'maadi', 'Maadi', 'المعادي', 29.9602, 31.2505,
   '{"type":"Polygon","coordinates":[[[31.22,29.94],[31.28,29.94],[31.28,29.98],[31.22,29.98],[31.22,29.94]]]}'::jsonb),
  ('dist-new-cairo', 'gov-cairo', 'new-cairo', 'New Cairo', 'القاهرة الجديدة', 30.0074, 31.4913,
   '{"type":"Polygon","coordinates":[[[31.45,29.98],[31.54,29.98],[31.54,30.04],[31.45,30.04],[31.45,29.98]]]}'::jsonb),
  ('dist-heliopolis', 'gov-cairo', 'heliopolis', 'Heliopolis', 'مصر الجديدة', 30.0876, 31.3225,
   '{"type":"Polygon","coordinates":[[[31.30,30.07],[31.35,30.07],[31.35,30.11],[31.30,30.11],[31.30,30.07]]]}'::jsonb),
  ('dist-6october', 'gov-giza', '6th-of-october', '6th of October', '6 أكتوبر', 29.9729, 30.9447,
   '{"type":"Polygon","coordinates":[[[30.88,29.94],[31.00,29.94],[31.00,30.02],[30.88,30.02],[30.88,29.94]]]}'::jsonb),
  ('dist-sheikh-zayed', 'gov-giza', 'sheikh-zayed', 'Sheikh Zayed', 'الشيخ زايد', 30.049, 30.976,
   '{"type":"Polygon","coordinates":[[[30.93,30.02],[31.02,30.02],[31.02,30.08],[30.93,30.08],[30.93,30.02]]]}'::jsonb)
ON CONFLICT ("id") DO UPDATE SET
  "governorateId" = EXCLUDED."governorateId",
  "slug" = EXCLUDED."slug",
  "nameEn" = EXCLUDED."nameEn",
  "nameAr" = EXCLUDED."nameAr",
  "lat" = EXCLUDED."lat",
  "lng" = EXCLUDED."lng",
  "polygon" = EXCLUDED."polygon";

INSERT INTO "SportCategory" (
  "id", "slug", "nameEn", "nameAr", "icon", "accentColor", "activityKind"
) VALUES
  ('sport-football', 'football', 'Football', 'كرة قدم', 'football', '#0E7A4E', 'field-sport'),
  ('sport-football-5', 'football-5', 'Football 5-a-side', 'كرة قدم خماسية', 'football', '#0E7A4E', 'field-sport'),
  ('sport-padel', 'padel', 'Padel', 'بادل', 'padel', '#3DA9FC', 'racket-court'),
  ('sport-tennis', 'tennis', 'Tennis', 'تنس', 'tennis', '#F2B705', 'racket-court'),
  ('sport-basketball', 'basketball', 'Basketball', 'كرة سلة', 'basketball', '#FF8A3D', 'field-sport'),
  ('sport-swimming', 'swimming', 'Swimming', 'سباحة', 'swimming', '#2DD4BF', 'field-sport'),
  ('sport-squash', 'squash', 'Squash', 'اسكواش', 'squash', '#8B5CF6', 'racket-court'),
  ('sport-volleyball', 'volleyball', 'Volleyball', 'كرة طائرة', 'volleyball', '#F97316', 'field-sport'),
  ('sport-playstation', 'playstation', 'PlayStation', 'بلايستيشن', 'playstation', '#C6FF3D', 'gaming-station'),
  ('sport-billiards', 'billiards', 'Billiards', 'بلياردو', 'billiards', '#7C3AED', 'table-game'),
  ('sport-table-tennis', 'table-tennis', 'Table Tennis', 'بينج بونج', 'table-tennis', '#22C7B8', 'table-game')
ON CONFLICT ("id") DO UPDATE SET
  "slug" = EXCLUDED."slug",
  "nameEn" = EXCLUDED."nameEn",
  "nameAr" = EXCLUDED."nameAr",
  "icon" = EXCLUDED."icon",
  "accentColor" = EXCLUDED."accentColor",
  "activityKind" = EXCLUDED."activityKind";

INSERT INTO "Amenity" ("id", "key", "nameEn", "nameAr", "icon") VALUES
  ('amenity-parking', 'parking', 'Parking', 'موقف سيارات', 'car'),
  ('amenity-showers', 'showers', 'Showers', 'دش', 'shower'),
  ('amenity-lighting', 'lighting', 'Floodlights', 'إضاءة', 'lightbulb'),
  ('amenity-floodlights', 'floodlights', 'Floodlights', 'إضاءة كاشفة', 'lightbulb'),
  ('amenity-cafe', 'cafe', 'Cafe', 'كافيه', 'coffee'),
  ('amenity-lockers', 'lockers', 'Lockers', 'خزائن', 'lock'),
  ('amenity-wifi', 'wifi', 'Wi-Fi', 'واي فاي', 'wifi'),
  ('amenity-female-friendly', 'femaleFriendly', 'Women-friendly', 'أوقات للنساء', 'user-check'),
  ('amenity-indoor', 'indoor', 'Indoor', 'مغلق', 'home')
ON CONFLICT ("key") DO UPDATE SET
  "nameEn" = EXCLUDED."nameEn",
  "nameAr" = EXCLUDED."nameAr",
  "icon" = EXCLUDED."icon";

INSERT INTO "PlatformSetting" (
  "id", "serviceFeePct", "coinsPerHundredEgp", "coinToEgpRate", "updatedAt"
) VALUES (1, 5, 10, 20, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "GameCatalogEntry" (
  "id", "slug", "nameEn", "nameAr", "genre", "ageRating", "createdAt"
) VALUES
  ('game-football-champions', 'football-champions', 'Football Champions', 'أبطال كرة القدم', 'sports', 'everyone', CURRENT_TIMESTAMP),
  ('game-street-racers', 'street-racers', 'Street Racers', 'سباق الشوارع', 'racing', 'everyone', CURRENT_TIMESTAMP),
  ('game-tactical-strike', 'tactical-strike', 'Tactical Strike', 'الهجوم التكتيكي', 'shooter', 'mature', CURRENT_TIMESTAMP),
  ('game-iron-fists', 'iron-fists', 'Iron Fists', 'قبضات حديدية', 'fighting', 'teen', CURRENT_TIMESTAMP),
  ('game-kart-rivals', 'kart-rivals', 'Kart Rivals', 'منافسو الكارتينج', 'racing', 'everyone', CURRENT_TIMESTAMP),
  ('game-battle-arena', 'battle-arena', 'Battle Arena', 'ساحة المعركة', 'shooter', 'teen', CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO UPDATE SET
  "nameEn" = EXCLUDED."nameEn",
  "nameAr" = EXCLUDED."nameAr",
  "genre" = EXCLUDED."genre",
  "ageRating" = EXCLUDED."ageRating",
  "active" = true;

INSERT INTO "MembershipPlan" (
  "id", "slug", "nameEn", "nameAr", "scope", "priceAmount", "priceCurrency",
  "includedHours", "overageDiscountPercent", "perksEn", "perksAr", "createdAt", "updatedAt"
) VALUES
  ('plan-gaming-pass', 'gaming-pass', 'Matchena Gaming Pass', 'اشتراك ماتشنا للألعاب', 'gaming',
   60000, 'EGP', 20, 15,
   ARRAY['Priority Rescue Match matching', 'No service fee on gaming bookings'],
   ARRAY['أولوية في مطابقة Rescue Match', 'بدون رسوم خدمة على حجوزات الألعاب'],
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('plan-all-access', 'all-access', 'Matchena All-Access', 'اشتراك ماتشنا الشامل', 'all-activities',
   120000, 'EGP', 15, 10,
   ARRAY['15% off every activity', 'Priority Rescue Match matching', 'Free coins bonus monthly'],
   ARRAY['خصم 15% على كل الأنشطة', 'أولوية في مطابقة Rescue Match', 'مكافأة كوينز شهرية مجانية'],
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO UPDATE SET
  "nameEn" = EXCLUDED."nameEn",
  "nameAr" = EXCLUDED."nameAr",
  "scope" = EXCLUDED."scope",
  "priceAmount" = EXCLUDED."priceAmount",
  "priceCurrency" = EXCLUDED."priceCurrency",
  "includedHours" = EXCLUDED."includedHours",
  "overageDiscountPercent" = EXCLUDED."overageDiscountPercent",
  "perksEn" = EXCLUDED."perksEn",
  "perksAr" = EXCLUDED."perksAr",
  "active" = true,
  "updatedAt" = CURRENT_TIMESTAMP;
