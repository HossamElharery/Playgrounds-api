import { asciiDigits, normalizeGuestPhone, phoneSearchNeedle } from './guest-phone.util';

describe('normalizeGuestPhone', () => {
  it.each([
    ['01012345678', '+201012345678'],
    ['+20 101 234 5678', '+201012345678'],
    ['٠١٠١٢٣٤٥٦٧٨', '+201012345678'],
    ['201012345678', '+201012345678'],
    ['0020 101 234 5678', '+201012345678'],
    ['010-1234-5678', '+201012345678'],
    ['+971 50 123 4567', '+971501234567'],
  ])('%s → %s', (raw, expected) => expect(normalizeGuestPhone(raw)).toBe(expected));

  it('rejects things that are not a phone number', () => {
    expect(normalizeGuestPhone('')).toBeNull();
    expect(normalizeGuestPhone('عميل')).toBeNull();
    expect(normalizeGuestPhone('123')).toBeNull();
    expect(normalizeGuestPhone('pending-abc')).toBeNull();
    expect(normalizeGuestPhone(undefined)).toBeNull();
  });

  it('turns Arabic digits and separators into ASCII', () => {
    expect(asciiDigits('٣٠٠٫٥٠')).toBe('300.50');
  });

  it('search needle drops the leading zero so 010… finds +2010…', () => {
    expect(phoneSearchNeedle('01012')).toBe('1012');
    expect(phoneSearchNeedle('12')).toBeNull();
  });
});
