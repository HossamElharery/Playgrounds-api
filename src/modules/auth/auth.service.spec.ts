import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { OTP_DELIVERY } from '../sms/otp-delivery.interface';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let otpDelivery: any;

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), create: jest.fn() },
      otpCode: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      refreshToken: { create: jest.fn() },
    };
    otpDelivery = { send: jest.fn() };

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
});
