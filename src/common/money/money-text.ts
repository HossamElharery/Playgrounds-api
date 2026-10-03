import { currencyLabel } from './currency-label';

/**
 * An amount for a sentence a person reads (a notification, an SMS): integer minor units in,
 * "200 ج.م" / "200 EGP" out. Never print `${amount} ${currency}` — that shows 20000 for a
 * 200-pound debt and a bare ISO code in an Arabic sentence.
 */
export function moneyText(minor: number, currency: string, lang: 'ar' | 'en'): string {
  const major = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(
    (Number.isFinite(minor) ? minor : 0) / 100,
  );
  return `${major} ${currencyLabel(currency, lang)}`;
}
