import { moneyText } from './money-text';

describe('moneyText', () => {
  it('turns minor units into the major amount with the venue currency label', () => {
    expect(moneyText(20000, 'EGP', 'ar')).toBe('200 ج.م');
    expect(moneyText(20000, 'EGP', 'en')).toBe('200 EGP');
    expect(moneyText(12550, 'AED', 'ar')).toBe('125.5 د.إ');
    expect(moneyText(5000, 'SAR', 'ar')).toBe('50 ر.س');
  });
  it('never prints minor units as if they were major', () => {
    expect(moneyText(5000, 'EGP', 'en')).not.toContain('5000');
  });
  it('falls back to the code for a currency it does not know', () => {
    expect(moneyText(100, 'XYZ', 'en')).toBe('1 XYZ');
  });
});
