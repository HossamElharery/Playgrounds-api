import { formatMajorText, moneyText } from './money-text';

describe('moneyText', () => {
  it('turns minor units into the major amount with the venue currency label', () => {
    expect(moneyText(20000, 'EGP', 'ar')).toBe('200 ج.م');
    expect(moneyText(20000, 'EGP', 'en')).toBe('200 EGP');
    expect(moneyText(12550, 'AED', 'ar')).toBe('125.50 د.إ');
    expect(moneyText(5000, 'SAR', 'ar')).toBe('50 ر.س');
  });
  it('never prints minor units as if they were major', () => {
    expect(moneyText(5000, 'EGP', 'en')).not.toContain('5000');
  });
  it('falls back to the code for a currency it does not know', () => {
    expect(moneyText(100, 'XYZ', 'en')).toBe('1 XYZ');
  });
  it('groups thousands and uses Latin digits in Arabic', () => {
    expect(moneyText(123456700, 'EGP', 'ar')).toBe('1,234,567 ج.م');
    expect(moneyText(150, 'EGP', 'ar')).toBe('1.50 ج.م');
  });
  it('writes the currency\'s own decimals for three-decimal currencies', () => {
    expect(formatMajorText(1.25, 'KWD', 'en')).toBe('1.250 KWD');
    expect(formatMajorText(1.25, 'KWD', 'ar')).toBe('1.250 د.ك');
    expect(formatMajorText(12, 'JOD', 'ar')).toBe('12 د.أ');
    expect(formatMajorText(2.5, 'LYD', 'ar')).toBe('2.500 د.ل');
  });
  it('is stable for float noise and negatives', () => {
    expect(formatMajorText(1.005, 'EGP', 'en')).toBe('1.01 EGP');
    expect(formatMajorText(-130.5, 'EGP', 'en')).toBe('-130.50 EGP');
    expect(formatMajorText(Number.NaN, 'EGP', 'en')).toBe('0 EGP');
  });
});
