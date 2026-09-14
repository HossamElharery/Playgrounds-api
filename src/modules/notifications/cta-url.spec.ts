import { BadRequestException } from '@nestjs/common';
import { sanitizeNotificationCtaUrl } from './cta-url';

describe('sanitizeNotificationCtaUrl', () => {
  it('keeps in-app paths', () => {
    expect(sanitizeNotificationCtaUrl('/en/venues/neon-arena')).toBe('/en/venues/neon-arena');
  });

  it('keeps https URLs', () => {
    expect(sanitizeNotificationCtaUrl('https://mal3ab.app/ar/explore')).toBe(
      'https://mal3ab.app/ar/explore',
    );
  });

  it('rejects javascript URLs', () => {
    expect(() => sanitizeNotificationCtaUrl('javascript:alert(1)')).toThrow(BadRequestException);
  });
});
