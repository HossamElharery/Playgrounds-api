import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthService } from './auth.service';

type Harness = { service: AuthService; prisma: any; verify: jest.Mock };

function harness(): Harness {
  const config = {
    get: (key: string) =>
      ({
        GOOGLE_CLIENT_ID: 'web-client',
        FACEBOOK_APP_ID: 'fb-app',
        FACEBOOK_APP_SECRET: 'fb-secret',
      })[key],
  };
  const prisma: any = {
    oAuthIdentity: { findUnique: jest.fn(), create: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  };
  const service = new (AuthService as any)(
    prisma,
    { signAsync: jest.fn().mockResolvedValue('jwt') },
    config,
    { send: jest.fn() },
    {},
    { accountCompleted: jest.fn() },
  ) as AuthService;
  const verify = jest.fn();
  (service as any).googleOAuthClient = { verifyIdToken: verify };
  (service as any).issueTokenPair = jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
  (service as any).sanitize = (u: unknown) => u;
  return { service, prisma, verify };
}

const ticket = (payload: Record<string, unknown>) => ({ getPayload: () => payload });
const claims = { sub: 'g-1', email: 'p@matchena.com', email_verified: true, nonce: 'n-1' };
const activeUser = { id: 'u1', status: 'active', avatarUrl: 'x', emailVerifiedAt: new Date() };

describe('AuthService social sign-in', () => {
  it('retries a failed Google key fetch once and then signs in', async () => {
    const { service, prisma, verify } = harness();
    verify
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(ticket(claims));
    prisma.oAuthIdentity.findUnique.mockResolvedValue({ user: activeUser });

    const result = await service.oauthGoogle({ idToken: 't', nonce: 'n-1' });

    expect(verify).toHaveBeenCalledTimes(2);
    expect(result.user).toBe(activeUser);
  });

  it('answers 503, not "invalid token", when Google keys stay unreachable', async () => {
    const { service, verify } = harness();
    verify.mockRejectedValue(Object.assign(new Error('fetch failed'), { name: 'GaxiosError' }));

    await expect(service.oauthGoogle({ idToken: 't', nonce: 'n-1' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rejects a bad Google token without retrying', async () => {
    const { service, verify } = harness();
    verify.mockRejectedValue(new Error('Wrong recipient, payload audience != requiredAudience'));

    await expect(service.oauthGoogle({ idToken: 't' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('requires the nonce in the token when the app sent one', async () => {
    const { service, verify } = harness();
    verify.mockResolvedValue(ticket({ ...claims, nonce: undefined }));

    await expect(service.oauthGoogle({ idToken: 't', nonce: 'n-1' })).rejects.toThrow(/nonce/i);
  });

  it('finds the account when a parallel first sign-in already created it', async () => {
    const { service, prisma, verify } = harness();
    verify.mockResolvedValue(ticket(claims));
    prisma.oAuthIdentity.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user: activeUser });
    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.oAuthIdentity.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
    );

    const result = await service.oauthGoogle({ idToken: 't', nonce: 'n-1' });

    expect(result.user).toBe(activeUser);
  });

  it('answers 503 when Facebook cannot be reached', async () => {
    const { service } = harness();
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    try {
      await expect(service.oauthFacebook({ accessToken: 'x' })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
