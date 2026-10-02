import { identityRef, redactText, storedQuotaKey } from './ai-redact';

describe('redactText', () => {
  it('removes phone numbers however they are written', () => {
    expect(redactText('كلمني على 01012345678 ضروري')).toBe('كلمني على [number] ضروري');
    expect(redactText('call +20 101 234 5678 now')).toBe('call [number] now');
    expect(redactText('رقمي ٠١٠١٢٣٤٥٦٧٨')).toBe('رقمي [number]');
    expect(redactText('0101-234-5678')).toBe('[number]');
  });

  it('removes emails and links', () => {
    expect(redactText('mail me at sara.k+test@example.co.uk')).toBe('mail me at [email]');
    expect(redactText('see https://x.com/a?b=1 please')).toBe('see [link] please');
  });

  it('keeps ordinary numbers a player says about a search', () => {
    expect(redactText('ملعب تحت 300 جنيه 5x5')).toBe('ملعب تحت 300 جنيه 5x5');
  });

  it('caps the length', () => {
    expect(redactText('a'.repeat(500), 300)).toHaveLength(300);
  });
});

describe('identity hashing', () => {
  it('is stable, short and not reversible by inspection', () => {
    const a = identityRef('salt', '41.1.1.1');
    expect(a).toBe(identityRef('salt', '41.1.1.1'));
    expect(a).toHaveLength(12);
    expect(a).not.toContain('41');
    expect(identityRef('other', '41.1.1.1')).not.toBe(a);
  });

  it('hashes addresses and devices but leaves a user id alone', () => {
    expect(storedQuotaKey('s', 'ip:1.2.3.4')).toMatch(/^ip:[0-9a-f]{12}$/);
    expect(storedQuotaKey('s', 'dev:abc12345')).toMatch(/^dev:[0-9a-f]{12}$/);
    expect(storedQuotaKey('s', 'user:u-1')).toBe('user:u-1');
  });
});
