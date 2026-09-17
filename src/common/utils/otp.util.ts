import { randomInt } from 'crypto';

/** Cryptographically random numeric code. Default 6 digits for email delivery. */
export function generateOtp(length = 6): string {
  const size = Math.min(10, Math.max(4, length));
  const min = 10 ** (size - 1);
  const max = 10 ** size;
  return randomInt(min, max).toString();
}
