CREATE TABLE "PageSeoOverride" (
  "key" VARCHAR(50) NOT NULL,
  "titleAr" VARCHAR(60) NOT NULL,
  "titleEn" VARCHAR(60) NOT NULL,
  "descriptionAr" VARCHAR(160) NOT NULL,
  "descriptionEn" VARCHAR(160) NOT NULL,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PageSeoOverride_pkey" PRIMARY KEY ("key")
);

INSERT INTO "PageSeoOverride" ("key", "titleAr", "titleEn", "descriptionAr", "descriptionEn") VALUES
('homepage', 'ملعب | احجز ملاعب كرة قدم وبادل في مصر', 'Mal3ab | Book Sports Venues in Egypt', 'اكتشف واحجز أفضل ملاعب كرة القدم والبادل والرياضات في مصر. قارن الأسعار والمواعيد والخدمات واحجز فوراً مع ملعب.', 'Discover and book football, padel and sports venues across Egypt. Compare live prices, availability and amenities, then book instantly.'),
('about', 'عن ملعب | أسهل طريقة لحجز الملاعب في مصر', 'About Mal3ab | Easier Sports Booking in Egypt', 'تعرّف على منصة ملعب ورسالتنا في جعل اكتشاف الملاعب ومقارنة المواعيد والأسعار والحجز في مصر تجربة أسهل وأوضح.', 'Learn how Mal3ab makes discovering venues, comparing live times and prices, and booking sports across Egypt simpler and clearer.'),
('partners', 'شركاء ملعب | نمّي حجوزات منشأتك الرياضية', 'Mal3ab Partners | Grow Your Sports Venue', 'انضم كشريك إلى ملعب وأدر مواعيد وأسعار منشأتك الرياضية، واستقبل حجوزات أكثر من لاعبين يبحثون عن مكان مناسب.', 'Join Mal3ab as a venue partner, manage schedules and pricing, and reach more players ready to book the right place to play.');
