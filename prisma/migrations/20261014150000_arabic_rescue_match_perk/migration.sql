-- Arabic membership perks still carried the English feature name "Rescue Match".
-- The app calls it «إنقاذ ماتش» everywhere else (Pulse). Text-only change.
UPDATE "MembershipPlan"
SET "perksAr" = array_replace("perksAr", 'أولوية في مطابقة Rescue Match', 'أولوية في ماتشات «إنقاذ ماتش»')
WHERE 'أولوية في مطابقة Rescue Match' = ANY("perksAr");
