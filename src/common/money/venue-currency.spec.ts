import { BadRequestException } from '@nestjs/common';
import { currencyLabel } from './currency-label';
import { assertVenueCurrency } from './venue-currency';

describe('assertVenueCurrency', () => {
  it('accepts the venue currency, in any letter case, or no currency at all', () => {
    expect(() => assertVenueCurrency('AED', 'aed')).not.toThrow();
    expect(() => assertVenueCurrency('AED')).not.toThrow();
    expect(() => assertVenueCurrency('AED', null)).not.toThrow();
  });

  it('rejects a price in another currency', () => {
    expect(() => assertVenueCurrency('AED', 'EGP')).toThrow(BadRequestException);
    try {
      assertVenueCurrency('AED', 'EGP');
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'VENUE_CURRENCY_MISMATCH' });
    }
  });
});

describe('currencyLabel', () => {
  it('writes every supported country currency the way people say it', () => {
    expect(currencyLabel('EGP', 'ar')).toBe('ج.م');
    expect(currencyLabel('AED', 'ar')).toBe('د.إ');
    expect(currencyLabel('SAR', 'ar', true)).toBe('ريال');
    expect(currencyLabel('AED', 'en')).toBe('AED');
  });

  it('shows an unknown code as is rather than hiding it', () => {
    expect(currencyLabel('XYZ', 'ar')).toBe('XYZ');
  });
});
