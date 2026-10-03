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

describe('normalizeGuestPhone — each country\'s own way of typing a local number', () => {
  it.each([
    ['AE', '0501234567', '+971501234567'],
    ['AE', '971501234567', '+971501234567'],
    ['AE', '+971 50 123 4567', '+971501234567'],
    ['SA', '0551234567', '+966551234567'],
    ['KW', '51234567', '+96551234567'],
    ['QA', '55123456', '+97455123456'],
    ['JO', '0791234567', '+962791234567'],
    ['EG', '01012345678', '+201012345678'],
  ])('%s: %s → %s', (country, raw, expected) => expect(normalizeGuestPhone(raw, country)).toBe(expected));

  it('does not mistake an Egyptian mobile for a UAE one (the wrong default used to do exactly that the other way round)', () => {
    expect(normalizeGuestPhone('01012345678', 'AE')).toBe('01012345678'); // not a UAE number: kept as typed, never rewritten
    expect(normalizeGuestPhone('0501234567')).toBe('0501234567'); // Egypt default: not an Egyptian mobile either
  });

  it('an unknown country falls back to Egypt', () => {
    expect(normalizeGuestPhone('01012345678', 'XX')).toBe('+201012345678');
  });
});
