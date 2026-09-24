import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { verifyAppleIdentityToken } from './apple-identity';

jest.mock('./apple-identity', () => ({ verifyAppleIdentityToken: jest.fn() }));
const verify = verifyAppleIdentityToken as jest.Mock;

describe('AuthService.oauthApple', () => {
  function build(config: Record<string, string> = {}) {
    const service = Object.create(AuthService.prototype) as AuthService & Record<string, unknown>;
    Object.assign(service, { config: { get: (key: string) => config[key] } });
    const findOrCreate = jest
      .spyOn(service as never, 'findOrCreateOAuthUser' as never)
      .mockResolvedValue({ id: 'u1', roles: ['player'] } as never);
    jest.spyOn(service as never, 'issueTokenPair' as never).mockResolvedValue({ accessToken: 'a', refreshToken: 'r' } as never);
    jest.spyOn(service as never, 'sanitize' as never).mockImplementation(((u: unknown) => u) as never);
    return { service, findOrCreate };
  }

  beforeEach(() => verify.mockReset());

  it('checks the token against the bundle ID and links a verified email', async () => {
    verify.mockResolvedValue({ sub: 'apple-1', email: 'p@privaterelay.appleid.com', email_verified: 'true', nonce: 'n1' });
    const { service, findOrCreate } = build();
    const result = await service.oauthApple({ identityToken: 't', nonce: 'n1', name: 'Omar' });
    expect(verify).toHaveBeenCalledWith('t', ['com.matchena.app']);
    expect(findOrCreate).toHaveBeenCalledWith({
      provider: 'apple',
      providerUserId: 'apple-1',
      email: 'p@privaterelay.appleid.com',
      name: 'Omar',
    });
    expect(result.accessToken).toBe('a');
  });

  it('never links by an unverified email', async () => {
    verify.mockResolvedValue({ sub: 'apple-2', email: 'x@y.com', email_verified: false });
    const { service, findOrCreate } = build({ APPLE_CLIENT_IDS: 'com.matchena.app, com.matchena.web' });
    await service.oauthApple({ identityToken: 't' });
    expect(verify).toHaveBeenCalledWith('t', ['com.matchena.app', 'com.matchena.web']);
    expect(findOrCreate).toHaveBeenCalledWith(expect.objectContaining({ email: undefined, name: 'Player' }));
  });

  it('rejects a bad signature or a nonce mismatch', async () => {
    verify.mockRejectedValueOnce(new Error('bad'));
    const { service } = build();
    await expect(service.oauthApple({ identityToken: 't' })).rejects.toBeInstanceOf(UnauthorizedException);
    verify.mockResolvedValueOnce({ sub: 's', nonce: 'other' });
    await expect(service.oauthApple({ identityToken: 't', nonce: 'mine' })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
