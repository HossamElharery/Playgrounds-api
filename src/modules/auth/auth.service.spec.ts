import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { OTP_DELIVERY } from '../sms/otp-delivery.interface';
import { EmailService } from '../email/email.service';
import * as bcrypt from 'bcrypt';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let otpDelivery: any;
  let email: any;

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      otpCode: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      refreshToken: { create: jest.fn() },
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };
    otpDelivery = { send: jest.fn() };
    email = {
      sendVerificationCode: jest.fn(),
      sendPasswordResetCode: jest.fn(),
      sendWelcome: jest.fn().mockResolvedValue(undefined),
      sendPasswordChanged: jest.fn().mockResolvedValue(undefined),
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
                OTP_TTL_SECONDS: 300,
                SALT_ROUNDS: 10,
                JWT_ACCESS_EXPIRES_IN: '15m',
                JWT_REFRESH_EXPIRES_IN: '7d',
              })[key] ?? fallback,
          },
        },
        { provide: OTP_DELIVERY, useValue: otpDelivery },
        { provide: EmailService, useValue: email },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('never returns the OTP code in the request-otp response', async () => {
    prisma.user.findUnique.mockResolvedValue(null); // new user -> register purpose

    const result = await service.requestOtp('+201001234567');

    expect(result).toEqual({ purpose: 'register' });
    expect(JSON.stringify(result)).not.toMatch(/\d{4}/); // no 4-digit code leaked anywhere in the response
  });

  it('delivers the OTP out-of-band via the OtpDelivery provider, not the response', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await service.requestOtp('+201001234567');

    expect(otpDelivery.send).toHaveBeenCalledTimes(1);
    const [target, code] = otpDelivery.send.mock.calls[0];
    expect(target).toBe('+201001234567');
    expect(code).toMatch(/^\d{4}$/);
  });

  it('rate-limits repeated OTP requests for the same phone within a minute', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.otpCode.count.mockResolvedValue(1); // one already sent recently

    await expect(service.requestOtp('+201001234567')).rejects.toThrow(/wait/i);
  });

  it('sends password-reset codes to an account email through EmailService', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'owner@matchena.com',
    });

    await service.requestPasswordReset({ email: 'OWNER@matchena.com' });

    expect(prisma.otpCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          target: 'owner@matchena.com',
          purpose: 'reset_password',
        }),
      }),
    );
    expect(email.sendPasswordResetCode).toHaveBeenCalledWith(
      'owner@matchena.com',
      expect.stringMatching(/^\d{4}$/),
      5,
    );
    expect(otpDelivery.send).not.toHaveBeenCalled();
  });

  it('refuses Google and Facebook until client credentials are configured', async () => {
    await expect(service.oauthGoogle({ idToken: 'x' })).rejects.toThrow(
      /not configured/i,
    );
    await expect(service.oauthFacebook({ accessToken: 'x' })).rejects.toThrow(
      /not configured/i,
    );
  });

  it('registers a player by email + password with no phone number', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.otpCode.findFirst.mockResolvedValue({
      id: 'otp1',
      codeHash: await bcrypt.hash('1234', 4),
      attempts: 0,
    });
    prisma.otpCode.update.mockResolvedValue({});
    prisma.user.create.mockResolvedValue({
      id: 'u2',
      email: 'nophone@matchena.com',
      emailVerifiedAt: new Date(),
      phone: null,
      name: 'No Phone Player',
      roles: ['player'],
      countryCode: 'EG',
      status: 'active',
    });

    const result = await service.registerPlayerEmail({
      email: 'nophone@matchena.com',
      password: 'Password123!',
      name: 'No Phone Player',
      code: '1234',
    });

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'nophone@matchena.com',
          emailVerifiedAt: expect.any(Date),
          phone: undefined,
          roles: ['player'],
          countryCode: 'EG',
        }),
      }),
    );
    expect(result.user.phone).toBeNull();
    expect(result.accessToken).toBe('signed.jwt.token');
    expect(email.sendWelcome).toHaveBeenCalledWith(
      'nophone@matchena.com',
      'No Phone Player',
    );
  });

  it('sends a single-use registration code to the normalized email', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await service.requestEmailRegistrationOtp(' NEW@Example.com ');

    expect(prisma.otpCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          target: 'new@example.com',
          purpose: 'register',
        }),
      }),
    );
    expect(email.sendVerificationCode).toHaveBeenCalledWith(
      'new@example.com',
      expect.stringMatching(/^\d{4}$/),
      5,
    );
  });

  it('rejects email registration with an invalid verification code', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.otpCode.findFirst.mockResolvedValue({
      id: 'otp2',
      codeHash: await bcrypt.hash('1234', 4),
      attempts: 0,
    });

    await expect(
      service.registerPlayerEmail({
        email: 'player@example.com',
        password: 'Password123!',
        name: 'Player',
        code: '9999',
      }),
    ).rejects.toThrow(/invalid code/i);
    expect(prisma.otpCode.update).toHaveBeenCalledWith({
      where: { id: 'otp2' },
      data: { attempts: { increment: 1 } },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects email registration when the email is already in use', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      service.registerPlayerEmail({
        email: 'taken@matchena.com',
        password: 'Password123!',
        name: 'Someone',
        code: '1234',
      }),
    ).rejects.toThrow(/already in use/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('lists only configured social providers', () => {
    expect(service.listLoginProviders()).toEqual({
      google: { enabled: false, clientId: undefined },
      facebook: { enabled: false, appId: undefined },
      passkeys: { enabled: true },
    });
  });
});
