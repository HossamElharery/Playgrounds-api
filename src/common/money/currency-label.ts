const LABELS: Record<string, { ar: string; arLong: string; en: string }> = {
  EGP: { ar: 'ج.م', arLong: 'جنيه', en: 'EGP' },
  AED: { ar: 'د.إ', arLong: 'درهم', en: 'AED' },
  SAR: { ar: 'ر.س', arLong: 'ريال', en: 'SAR' },
  KWD: { ar: 'د.ك', arLong: 'دينار كويتي', en: 'KWD' },
  QAR: { ar: 'ر.ق', arLong: 'ريال قطري', en: 'QAR' },
  JOD: { ar: 'د.أ', arLong: 'دينار أردني', en: 'JOD' },
  USD: { ar: '$', arLong: 'دولار', en: 'USD' },
  LYD: { ar: 'د.ل', arLong: 'دينار ليبي', en: 'LYD' },
  OMR: { ar: 'ر.ع', arLong: 'ريال عماني', en: 'OMR' },
  BHD: { ar: 'د.ب', arLong: 'دينار بحريني', en: 'BHD' },
  TND: { ar: 'د.ت', arLong: 'دينار تونسي', en: 'TND' },
  MAD: { ar: 'د.م', arLong: 'درهم مغربي', en: 'MAD' },
  IQD: { ar: 'د.ع', arLong: 'دينار عراقي', en: 'IQD' },
  SDG: { ar: 'ج.س', arLong: 'جنيه سوداني', en: 'SDG' },
};

export function currencyLabel(code: string, lang: 'ar' | 'en' = 'en', long = false): string {
  const row = LABELS[code?.toUpperCase()];
  if (!row) return code;
  if (lang === 'en') return row.en;
  return long ? row.arLong : row.ar;
}
