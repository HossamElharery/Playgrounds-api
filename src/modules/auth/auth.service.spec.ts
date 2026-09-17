import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { ApiException } from '../../common/errors/api-exception';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let email: { sendPasswordReset: jest.Mock; sendWelcome: jest.Mock; isConfigured: jest.Mock };

  const player = {
    id: 'u1',
    email: 'ahmed@matchena.com',
    phone: null,
    name: 'Ahmed',
    passwordHash: null,
    roles: ['player'],
    status: 'active',
    countryCode: 'EG',
    preferredLang: 'ar',
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      otpCode: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      refreshToken: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      countryConfig: { findFirst: jest.fn(), findMany: jest.fn() },
      $transaction: jest.fn(async (ops: unknown) =>
        Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: unknown) => unknown)(prisma),
      ),
    };
    email = {
      sendPasswordReset: jest.fn().mockResolvedValue(undefined),
      sendWelcome: jest.fn().mockResolvedValue(undefined),
      isConfigured: jest.fn().mockReturnValue(true),
    };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: {
            signAsync: jest.fn().mockResolvedValue('signed.jwt.token'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: unknown) =>
              ({
                OTP_TTL_SECONDS: 600,
                SALT_ROUNDS: 10,
                JWT_ACCESS_EXPIRES_IN: '15m',
                JWT_REFRESH_EXPIRES_IN: '7d',
                NODE_ENV: 'test',
              })[key] ?? fallback,
          },
        },
        { provide: EmailService, useValue: email },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('registerPlayerEmail', () => {
    it('creates a player with email and no phone', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        ...player,
        passwordHash: 'hashed',
      });

      const result = await service.registerPlayerEmail({
        email: 'Ahmed@Matchena.com',
        password: 'Password123!',
        name: 'Ahmed Mohamed',
      });

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'ahmed@matchena.com',
          phone: null,
          name: 'Ahmed Mohamed',
          roles: ['player'],
          countryCode: 'EG',
        }),
      });
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('rejects a duplicate email', async () => {
      prisma.user.findUnique.mockResolvedValue(player);
      await expect(
        service.registerPlayerEmail({
          email: 'ahmed@matchena.com',
          password: 'Password123!',
          name: 'Ahmed',
        }),
      ).rejects.toBeInstanceOf(ApiException);
    });
  });

  describe('loginEmail', () => {
    it('rejects unknown or passwordless accounts with the same message', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.loginEmail({ email: 'nobody@matchena.com', password: 'x' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('password reset', () => {
    it('does not leak whether the email exists', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.requestPasswordReset('missing@matchena.com'),
      ).resolves.toBeUndefined();
      expect(email.sendPasswordReset).not.toHaveBeenCalled();
      expect(prisma.otpCode.create).not.toHaveBeenCalled();
    });

    it('emails a code and never returns it', async () => {
      prisma.user.findUnique.mockResolvedValue(player);
      const result = await service.requestPasswordReset('ahmed@matchena.com');
      expect(result).toBeUndefined();
      expect(prisma.otpCode.create).toHaveBeenCalled();
      expect(email.sendPasswordReset).toHaveBeenCalledTimes(1);
      const [, code] = email.sendPasswordReset.mock.calls[0];
      expect(code).toMatch(/^\d{6}$/);
    });

    it('silently rate-limits repeated requests', async () => {
      prisma.otpCode.count.mockResolvedValue(1);
      await service.requestPasswordReset('ahmed@matchena.com');
      expect(email.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('resets the password when the code is valid', async () => {
      const hash = await bcrypt.hash('482917', 10);
      prisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1',
        codeHash: hash,
        attempts: 0,
      });
      prisma.user.findUnique.mockResolvedValue({
        ...player,
        passwordHash: 'old',
      });
      prisma.otpCode.update.mockResolvedValue({});
      prisma.user.update.mockResolvedValue({});
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      await service.resetPassword(
        'ahmed@matchena.com',
        '482917',
        'NewPassword123!',
      );

      expect(prisma.user.update).toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
    });
  });

  it('refuses Google and Facebook until client credentials are configured', async () => {
    await expect(service.oauthGoogle({ idToken: 'x' })).rejects.toThrow(
      /not configured/i,
    );
    await expect(
      service.oauthFacebook({ accessToken: 'x' }),
    ).rejects.toThrow(/not configured/i);
  });

  it('lists only configured social providers', () => {
    expect(service.listLoginProviders()).toEqual({
      google: { enabled: false, clientId: undefined },
      facebook: { enabled: false, appId: undefined },
      passkeys: { enabled: true },
    });
  });
});
