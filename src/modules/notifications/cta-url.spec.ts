import { BadRequestException } from '@nestjs/common';
import { localizedPushUrl, sanitizeNotificationCtaUrl } from './cta-url';

describe('sanitizeNotificationCtaUrl', () => {
  it('keeps in-app paths', () => {
    expect(sanitizeNotificationCtaUrl('/en/venues/neon-arena')).toBe('/en/venues/neon-arena');
  });

  it('keeps https URLs', () => {
    expect(sanitizeNotificationCtaUrl('https://matchena.com/ar/explore')).toBe(
      'https://matchena.com/ar/explore',
    );
  });

  it('rejects javascript URLs', () => {
    expect(() => sanitizeNotificationCtaUrl('javascript:alert(1)')).toThrow(BadRequestException);
  });

  it('rejects free text that is not a path or URL', () => {
    expect(() => sanitizeNotificationCtaUrl('Facere cupidatat officia non aut aliquam')).toThrow(
      BadRequestException,
    );
  });
});

describe('localizedPushUrl', () => {
  it('prefixes an app path with the user language so Web Push opens a real route', () => {
    expect(localizedPushUrl('/owner/bookings?venue=v1&booking=b1', 'ar')).toBe('/ar/owner/bookings?venue=v1&booking=b1');
    expect(localizedPushUrl('/app/bookings', 'en')).toBe('/en/app/bookings');
  });
  it('leaves already-localized, external and empty links alone', () => {
    expect(localizedPushUrl('/en/owner/today', 'ar')).toBe('/en/owner/today');
    expect(localizedPushUrl('https://example.com/x', 'ar')).toBe('https://example.com/x');
    expect(localizedPushUrl('//evil.example', 'ar')).toBe('//evil.example');
    expect(localizedPushUrl(undefined, 'ar')).toBeUndefined();
  });
});
