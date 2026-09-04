import { createHmac, timingSafeEqual } from 'crypto';

export interface QrPayload {
  bookingId: string;
  issuedAt: number;
}

/** Signs a compact, verifiable QR payload for a booking (HMAC-SHA256, not a bare bookingId). */
export function signQrPayload(bookingId: string, secret: string): string {
  const issuedAt = Date.now();
  const body = `${bookingId}.${issuedAt}`;
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  return Buffer.from(`${body}.${signature}`).toString('base64url');
}

export function verifyQrPayload(
  payload: string,
  secret: string,
): { valid: boolean; bookingId?: string } {
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const [bookingId, issuedAtStr, signature] = decoded.split('.');
    const expected = createHmac('sha256', secret)
      .update(`${bookingId}.${issuedAtStr}`)
      .digest('hex');
    const a = Buffer.from(signature ?? '');
    const b = Buffer.from(expected);
    const valid = a.length === b.length && timingSafeEqual(a, b);
    return valid ? { valid: true, bookingId } : { valid: false };
  } catch {
    return { valid: false };
  }
}
