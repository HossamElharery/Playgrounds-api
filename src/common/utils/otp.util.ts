import { randomInt } from 'node:crypto';

// Six-digit, cryptographically-random one-time code. A short numeric space must
// never be guessable, so use the CSPRNG rather than Math.random().
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
