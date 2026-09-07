import { signQrPayload, verifyQrPayload } from './qr.util';

describe('qr.util', () => {
  const secret = 'a'.repeat(32);

  it('round-trips a signed payload', () => {
    const payload = signQrPayload('booking-123', secret);
    const result = verifyQrPayload(payload, secret);
    expect(result.valid).toBe(true);
    expect(result.bookingId).toBe('booking-123');
  });

  it('rejects a payload signed with a different secret', () => {
    const payload = signQrPayload('booking-123', secret);
    const result = verifyQrPayload(payload, 'b'.repeat(32));
    expect(result.valid).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const payload = signQrPayload('booking-123', secret);
    const tampered = Buffer.from(
      Buffer.from(payload, 'base64url')
        .toString('utf8')
        .replace('booking-123', 'booking-999'),
    ).toString('base64url');
    const result = verifyQrPayload(tampered, secret);
    expect(result.valid).toBe(false);
  });

  it('rejects garbage input without throwing', () => {
    expect(verifyQrPayload('not-a-real-payload', secret).valid).toBe(false);
  });
});
