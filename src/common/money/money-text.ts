import { currencyLabel } from './currency-label';

export function moneyText(minor: number, currency: string, lang: 'ar' | 'en'): string {
  const major = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(
    (Number.isFinite(minor) ? minor : 0) / 100,
  );
  return `${major} ${currencyLabel(currency, lang)}`;
}
