import * as jwt from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';

export interface AppleIdentityClaims {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  is_private_email?: boolean | string;
  nonce?: string;
}

const APPLE_ISSUER = 'https://appleid.apple.com';
const jwks = new JwksClient({
  jwksUri: 'https://appleid.apple.com/auth/keys',
  cache: true,
  cacheMaxAge: 12 * 60 * 60 * 1000,
  rateLimit: true,
});

/**
 * Verify a Sign in with Apple identity token: RS256 signature against Apple's
 * published keys, issuer, audience (our bundle / services IDs) and expiry.
 */
export async function verifyAppleIdentityToken(
  token: string,
  audiences: string[],
): Promise<AppleIdentityClaims> {
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded && typeof decoded === 'object' ? decoded.header.kid : undefined;
  if (!kid) throw new Error('Apple token has no key id');
  const key = await jwks.getSigningKey(kid);
  const claims = jwt.verify(token, key.getPublicKey(), {
    algorithms: ['RS256'],
    issuer: APPLE_ISSUER,
    audience: audiences as [string, ...string[]],
  }) as AppleIdentityClaims;
  if (!claims.sub) throw new Error('Apple token has no subject');
  return claims;
}
