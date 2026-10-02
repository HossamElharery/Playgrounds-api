/**
 * How each currency is written to people. Amounts are stored as integers in
 * 1/100 of the major unit for every currency, so adding a country only needs a line here.
 */
const LABELS: Record<string, { ar: string; arLong: string; en: string }> = {
  EGP: { ar: 'ج.م', arLong: 'جنيه', en: 'EGP' },
  AED: { ar: 'د.إ', arLong: 'درهم', en: 'AED' },
  SAR: { ar: 'ر.س', arLong: 'ريال', en: 'SAR' },
  KWD: { ar: 'د.ك', arLong: 'دينار كويتي', en: 'KWD' },
  QAR: { ar: 'ر.ق', arLong: 'ريال قطري', en: 'QAR' },
  JOD: { ar: 'د.أ', arLong: 'دينار أردني', en: 'JOD' },
  USD: { ar: '$', arLong: 'دولار', en: 'USD' },
};

export function currencyLabel(code: string, lang: 'ar' | 'en' = 'en', long = false): string {
  const row = LABELS[code?.toUpperCase()];
  if (!row) return code;
  if (lang === 'en') return row.en;
  return long ? row.arLong : row.ar;
}
