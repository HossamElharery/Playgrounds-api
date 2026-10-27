-- /partners SEO quoted a 30-day trial. Point the seeded copy at the admin setting instead
-- ("{trialDays}" is filled by the API); an admin's own wording is left alone.
UPDATE "PageSeoOverride"
SET
  "descriptionAr" = REPLACE("descriptionAr", 'جرّب 30 يوم مجانًا', 'جرّب {trialDays} يوم مجانًا'),
  "descriptionEn" = REPLACE("descriptionEn", '30-day free trial', '{trialDays}-day free trial'),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'partners'
  AND ("descriptionAr" LIKE '%جرّب 30 يوم مجانًا%' OR "descriptionEn" LIKE '%30-day free trial%');
