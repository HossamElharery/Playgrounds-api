import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { OTP_DELIVERY } from '../sms/otp-delivery.interface';
import { EmailService } from '../email/email.service';
import { SquadService } from '../squad/squad.service';
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
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      refreshToken: { create: jest.fn() },
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };
    otpDelivery = { send: jest.fn() };
    email = {
      assertDeliveryAvailable: jest.fn(),
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
          provide: SquadService,
          useValue: {
            leaveCurrentSquad: jest.fn().mockResolvedValue(undefined),
          },
        },
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
    expect(JSON.stringify(result)).not.toMatch(/\d{6}/); // no OTP code leaked anywhere in the response
  });

  it('delivers the OTP out-of-band via the OtpDelivery provider, not the response', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await service.requestOtp('+201001234567');

    expect(otpDelivery.send).toHaveBeenCalledTimes(1);
    const [target, code] = otpDelivery.send.mock.calls[0];
    expect(target).toBe('+201001234567');
    expect(code).toMatch(/^\d{6}$/);
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
      roles: ['owner'],
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
      expect.stringMatching(/^\d{6}$/),
      5,
    );
    expect(otpDelivery.send).not.toHaveBeenCalled();
  });

  it('fails consistently before account lookup when email delivery is unavailable', async () => {
    email.assertDeliveryAvailable.mockImplementation(() => {
      throw new Error('Email delivery is temporarily unavailable');
    });
    await expect(
      service.requestPasswordReset({ email: 'owner@matchena.com' }),
    ).rejects.toThrow('Email delivery is temporarily unavailable');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.otpCode.create).not.toHaveBeenCalled();
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
      expect.stringMatching(/^\d{6}$/),
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
    // The attempt is spent atomically (conditional increment) before the code
    // is compared, so concurrent guesses cannot bypass the attempt ceiling.
    expect(prisma.otpCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'otp2',
          attempts: { lt: 5 },
        }),
        data: { attempts: { increment: 1 } },
      }),
    );
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

  describe('changePassword', () => {
    const activeUser = async (password: string) => ({
      id: 'u1',
      email: 'player@matchena.com',
      phone: null,
      name: 'Player',
      roles: ['player'],
      countryCode: 'EG',
      status: 'active',
      passwordHash: await bcrypt.hash(password, 4),
    });

    beforeEach(() => {
      prisma.user.update = jest.fn().mockResolvedValue({});
      prisma.refreshToken.updateMany = jest.fn().mockResolvedValue({ count: 2 });
    });

    it('rejects a wrong current password without touching the account', async () => {
      prisma.user.findUnique.mockResolvedValue(await activeUser('Correct123!'));

      await expect(service.changePassword('u1', 'Wrong123!', 'NewPass123!')).rejects.toThrow(/incorrect/i);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses accounts that sign in without a password', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...(await activeUser('x')), passwordHash: null });

      await expect(service.changePassword('u1', 'anything', 'NewPass123!')).rejects.toThrow(/without a password/i);
    });

    it('stores the new hash, signs out other sessions and returns fresh tokens', async () => {
      prisma.user.findUnique.mockResolvedValue(await activeUser('Correct123!'));

      const tokens = await service.changePassword('u1', 'Correct123!', 'NewPass123!');

      const saved = prisma.user.update.mock.calls[0][0].data.passwordHash as string;
      expect(await bcrypt.compare('NewPass123!', saved)).toBe(true);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1', revokedAt: null } }),
      );
      expect(email.sendPasswordChanged).toHaveBeenCalledWith('player@matchena.com');
      expect(tokens.accessToken).toBeTruthy();
    });
  });

  describe('partner registration markets', () => {
    const dto = { name: 'QA Owner', username: 'qa.owner', email: 'qa@example.com', password: 'Password12345' };

    it('generates a valid username for a minimal partner account without changing existing custom usernames', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockImplementation(async ({ data }: any) => ({ id: 'new-owner', ...data }));
      jest.spyOn(service, 'issueTokenPair' as any).mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' } as never);
      const { username, ...minimal } = dto;
      await service.registerPartner(minimal);
      expect(prisma.user.create.mock.calls[0][0].data.username).toMatch(/^owner_[a-f0-9]{20}$/);
      await service.registerPartner(dto);
      expect(prisma.user.create.mock.calls[1][0].data.username).toBe('qa.owner');
    });

    it('accepts a globally valid phone even when its calling code is not an active market', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockImplementation(async ({ data }: any) => ({ id: 'new-owner', ...data }));
      prisma.countryConfig = {
        findMany: jest.fn().mockResolvedValue([
          { code: 'EG', phoneCallingCode: '+20' },
          { code: 'SA', phoneCallingCode: '+966' },
        ]),
        findFirst: jest.fn(),
      };
      jest.spyOn(service, 'issueTokenPair' as any).mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' } as never);

      await service.registerPartner({ ...dto, phone: '+16092757733' } as never);

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ phone: '+16092757733', countryCode: 'EG' }),
      });
    });
  });
  it('promotes the same guest identity atomically without replacing profile or squad',async()=>{
    const guest={id:'guest-1',isGuest:true,name:'Guest',avatarUrl:'existing-avatar',roles:['player'],status:'active'};
    prisma.oAuthIdentity={findUnique:jest.fn().mockResolvedValue(null),create:jest.fn().mockResolvedValue({})};
    prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(guest);
    prisma.user.update=jest.fn().mockImplementation(async({data})=>({...guest,...data}));prisma.$queryRaw=jest.fn().mockResolvedValue([]);prisma.$transaction.mockImplementation(async fn=>fn(prisma));
    const result=await (service as any).findOrCreateOAuthUser({provider:'google',providerUserId:'google-1',guestUserId:'guest-1',email:'player@example.com',name:'Player',avatarUrl:'new-avatar'});
    expect(result.id).toBe('guest-1');expect(result.isGuest).toBe(false);expect(result.avatarUrl).toBe('existing-avatar');expect(prisma.user.create).not.toHaveBeenCalled();expect(prisma.oAuthIdentity.create).toHaveBeenCalledWith({data:{userId:'guest-1',provider:'google',providerUserId:'google-1',email:'player@example.com'}});
  });
  it('refuses to replace a guest with an already linked social account',async()=>{
    prisma.oAuthIdentity={findUnique:jest.fn().mockResolvedValue({user:{id:'existing-player'}})};
    await expect((service as any).findOrCreateOAuthUser({provider:'facebook',providerUserId:'fb-1',guestUserId:'guest-1',name:'Player'})).rejects.toMatchObject({status:409});expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('does not promote an expired or already completed guest',async()=>{
    prisma.oAuthIdentity={findUnique:jest.fn().mockResolvedValue(null)};prisma.$queryRaw=jest.fn();prisma.$transaction.mockImplementation(async fn=>fn(prisma));prisma.user.findUnique.mockResolvedValue({id:'guest-1',isGuest:false});
    await expect((service as any).findOrCreateOAuthUser({provider:'facebook',providerUserId:'fb-1',guestUserId:'guest-1',name:'Player'})).rejects.toMatchObject({status:403});expect(prisma.user.create).not.toHaveBeenCalled();
  });

});
