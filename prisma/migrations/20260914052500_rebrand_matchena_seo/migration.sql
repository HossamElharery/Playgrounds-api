UPDATE "PageSeoOverride"
SET
  "titleAr" = 'ماتشنا | احجز ملاعب كرة قدم وبادل في مصر',
  "titleEn" = 'Matchena | Book Sports Venues in Egypt',
  "descriptionAr" = 'اكتشف واحجز أفضل ملاعب كرة القدم والبادل والرياضات في مصر. قارن الأسعار والمواعيد والخدمات واحجز فوراً مع ماتشنا.',
  "descriptionEn" = 'Discover and book football, padel and sports venues across Egypt. Compare live prices, availability and amenities, then book instantly.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'homepage';

UPDATE "PageSeoOverride"
SET
  "titleAr" = 'عن ماتشنا | أسهل طريقة لحجز الملاعب في مصر',
  "titleEn" = 'About Matchena | Easier Sports Booking in Egypt',
  "descriptionAr" = 'تعرّف على منصة ماتشنا ورسالتنا في جعل اكتشاف الملاعب ومقارنة المواعيد والأسعار والحجز في مصر تجربة أسهل وأوضح.',
  "descriptionEn" = 'Learn how Matchena makes discovering venues, comparing live times and prices, and booking sports across Egypt simpler and clearer.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'about';

UPDATE "PageSeoOverride"
SET
  "titleAr" = 'شركاء ماتشنا | نمّي حجوزات منشأتك الرياضية',
  "titleEn" = 'Matchena Partners | Grow Your Sports Venue',
  "descriptionAr" = 'انضم كشريك إلى ماتشنا وأدر مواعيد وأسعار منشأتك الرياضية، واستقبل حجوزات أكثر من لاعبين يبحثون عن مكان مناسب.',
  "descriptionEn" = 'Join Matchena as a venue partner, manage schedules and pricing, and reach more players ready to book the right place to play.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'partners';
