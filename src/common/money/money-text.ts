import { currencyLabel } from './currency-label';

/**
 * The one way the API writes an amount into a message (push, email, WhatsApp, assistant): `130 ج.م`, `130.50 EGP`, `1.250 د.ك`.
 * Same rules as the web app's `formatMoneyMajor`: Latin digits, number then localized label, no decimals for whole amounts,
 * otherwise exactly the currency's own decimals. Money in bookings, wallet, cash and finance is stored as 1/100 of the major
 * unit for every currency, so `moneyText` takes that scale.
 */
export function formatMajorText(major: number, currency: string, lang: 'ar' | 'en'): string {
  const digits = currencyDigits(currency);
  const safe = Number.isFinite(major) ? major : 0;
  const rounded = Number(`${Math.round(Number(`${Math.abs(safe)}e${digits}`))}e-${digits}`) * Math.sign(safe);
  const fractional = !Number.isInteger(rounded);
  const number = new Intl.NumberFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US', {
    minimumFractionDigits: fractional ? digits : 0,
    maximumFractionDigits: fractional ? digits : 0,
  }).format(rounded === 0 ? 0 : rounded);
  const label = currency ? currencyLabel(currency, lang) : '';
  return label ? `${number} ${label}` : number;
}

export function moneyText(minor: number, currency: string, lang: 'ar' | 'en'): string {
  return formatMajorText((Number.isFinite(minor) ? minor : 0) / 100, currency, lang);
}

function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}
