UPDATE "PageSeoOverride"
SET
  "titleAr" = 'ماتشنا | احجز ملعبك في مصر',
  "titleEn" = 'Matchena | Book courts in Egypt',
  "descriptionAr" = 'شوف المواعيد والأسعار، أكّد الحجز، أو كمّل ماتش ناقص. كرة، بادل، تنس وأكتر — من غير مكالمة للملعب.',
  "descriptionEn" = 'Check open slots and prices, confirm your booking, or fill a short match. Football, padel, tennis and more — without calling the venue.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'homepage';

UPDATE "PageSeoOverride"
SET
  "titleAr" = 'عن ماتشنا | حجز الملاعب في مصر',
  "titleEn" = 'About Matchena | Court booking in Egypt',
  "descriptionAr" = 'ماتشنا بتخلي الميعاد والسعر ظاهرين قبل التأكيد. تشيك إن بالـ QR، وتقسيم الفاتورة، وPulse لو الماتش ناقص.',
  "descriptionEn" = 'Matchena shows the slot and price before you confirm. QR check-in, split pay, and Pulse when a match is short.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'about';

UPDATE "PageSeoOverride"
SET
  "titleAr" = 'شركاء ماتشنا | أدر المواعيد واستقبل الحجوزات',
  "titleEn" = 'Matchena Partners | List your courts',
  "descriptionAr" = 'انشر الجدول والأسعار، وبعد اعتماد الإدارة استقبل الحجوزات من التطبيق من غير مكالمات.',
  "descriptionEn" = 'Publish hours and prices. After verification, take in-app bookings without phone calls.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'partners';
