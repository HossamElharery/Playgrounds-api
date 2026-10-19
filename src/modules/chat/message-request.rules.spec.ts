import {
  REQUEST_MESSAGE_MAX_LENGTH,
  containsLink,
  containsPhoneNumber,
  fingerprintMessage,
  validateRequestMessage,
} from './message-request.rules';

describe('message request content rules', () => {
  describe('links', () => {
    it.each([
      'check https://evil.example/x',
      'http://a.b',
      'visit www.site',
      'www . site . com',
      'my page example.com',
      'example (dot) com',
      'example[dot]com',
      'add me wa.me/201012345678',
      't.me/someone',
      'bit.ly/abc',
      'instagram.com/me',
      'exa​mple.com',
      'ＥＸＡＭＰＬＥ．ＣＯＭ',
    ])('flags %s', (text) => expect(containsLink(text)).toBe(true));

    it.each([
      'يلا نلعب بكرا الساعة 8؟',
      'Want to play 5v5 tomorrow at 9pm. Ok?',
      'hello.how are you',
      'مين معاه ملعب في مدينة نصر',
      'see you at the pitch.com on the way',
    ])('allows %s', (text) => {
      // the last sample contains a ".com" on purpose: it IS treated as a link
      expect(containsLink(text)).toBe(text.includes('pitch.com'));
    });
  });

  describe('phone numbers', () => {
    it.each([
      '01012345678',
      '+20 101 234 5678',
      '0101-234-5678',
      '0 1 0 1 2 3 4 5 6 7 8',
      '٠١٠١٢٣٤٥٦٧٨',
      '۰۱۰۱۲۳۴۵۶۷۸',
      'call 010.1234.5678 now',
      '(010) 1234 5678',
      '0​1012345678',
    ])('flags %s', (text) => expect(containsPhoneNumber(text)).toBe(true));

    it.each([
      'الساعة 8 والملعب 5',
      'ندفع 150 جنيه كل واحد',
      'Booking 12345',
      'we are 10 players, pitch 3, at 9',
      '2026-10-19',
      'يوم 19/10/2026 الساعة 9',
    ])('allows %s', (text) => expect(containsPhoneNumber(text)).toBe(false));
  });

  describe('validateRequestMessage', () => {
    it('accepts a short plain text message', () => {
      expect(
        validateRequestMessage({ type: 'text', text: 'يلا نلعب؟' }),
      ).toBeNull();
    });
    it('rejects attachments', () => {
      expect(validateRequestMessage({ type: 'image' })).toBe(
        'MESSAGE_REQUEST_TEXT_ONLY',
      );
      expect(validateRequestMessage({ type: 'voice' })).toBe(
        'MESSAGE_REQUEST_TEXT_ONLY',
      );
    });
    it('rejects over-long text', () => {
      const text = 'a'.repeat(REQUEST_MESSAGE_MAX_LENGTH + 1);
      expect(validateRequestMessage({ type: 'text', text })).toBe(
        'MESSAGE_REQUEST_TOO_LONG',
      );
      expect(
        validateRequestMessage({
          type: 'text',
          text: 'a'.repeat(REQUEST_MESSAGE_MAX_LENGTH),
        }),
      ).toBeNull();
    });
    it('checks links before phone numbers', () => {
      expect(
        validateRequestMessage({
          type: 'text',
          text: 'http://x.co 01012345678',
        }),
      ).toBe('MESSAGE_REQUEST_NO_LINKS');
      expect(
        validateRequestMessage({ type: 'text', text: 'call 01012345678' }),
      ).toBe('MESSAGE_REQUEST_NO_CONTACT_INFO');
    });
  });

  it('fingerprints the same text regardless of case, punctuation, digits script and spacing', () => {
    expect(fingerprintMessage('Hello,  WORLD!! 123')).toBe(
      fingerprintMessage('hello world ١٢٣'),
    );
    expect(fingerprintMessage('a')).not.toBe(fingerprintMessage('b'));
  });
});
