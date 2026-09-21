import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotImplementedException,
  UnauthorizedException,
  forwardRef,
} from '@nestjs/common';
import { GuestJoinDto } from './dto/guest-join.dto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { OTP_DELIVERY, OtpDelivery } from '../sms/otp-delivery.interface';
import { generateOtp } from '../../common/utils/otp.util';
import { normalizeCountryCode } from '../../common/geo/country.util';
import { OAuthProvider, OtpPurpose, User } from '@prisma/client';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { LoginEmailDto } from './dto/login-email.dto';
import { RegisterOwnerDto } from './dto/register-owner.dto';
import { RegisterEmailDto } from './dto/register-email.dto';
import {
  PartnerLoginDto,
  PartnerRegisterDto,
} from '../partners/dto/partner-auth.dto';
import {
  isValidUsername,
  normalizeUsername,
} from '../../common/utils/username.util';
import { ApiException } from '../../common/errors/api-exception';
import { OAuthGoogleDto } from './dto/oauth-google.dto';
import { OAuthFacebookDto } from './dto/oauth-facebook.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { SquadService } from '../squad/squad.service';
import { EmailService } from '../email/email.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    @Inject(OTP_DELIVERY) private readonly otpDelivery: OtpDelivery,
    private readonly email: EmailService,
    @Inject(forwardRef(() => SquadService))
    private readonly squad: SquadService,
  ) {}

  // ---------- password / token primitives ----------

  private hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, this.config.get<number>('SALT_ROUNDS', 10));
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private async issueTokenPair(
    user: Pick<User, 'id' | 'phone' | 'email' | 'name' | 'roles' | 'countryCode'>,
    deviceInfo?: string,
  ): Promise<TokenPair> {
    const payload = {
      id: user.id,
      phone: user.phone,
      email: user.email,
      name: user.name,
      roles: user.roles,
      countryCode: user.countryCode,
    };

    const accessExpiresIn = this.config.get<string>(
      'JWT_ACCESS_EXPIRES_IN',
      '15m',
    );
    const refreshExpiresIn = this.config.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '7d',
    );

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: accessExpiresIn as any,
    });

    const refreshToken = await this.jwtService.signAsync(
      { sub: user.id, jti: crypto.randomUUID() },
      {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshExpiresIn as any,
      },
    );

    const expiresAt = new Date(
      Date.now() + this.parseDurationMs(refreshExpiresIn),
    );
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.sha256(refreshToken),
        deviceInfo,
        expiresAt,
      },
    });

    return { accessToken, refreshToken, expiresIn: accessExpiresIn };
  }

  private parseDurationMs(duration: string): number {
    const match = /^(\d+)([smhd])$/.exec(duration);
    if (!match) return 7 * 24 * 60 * 60 * 1000;
    const value = Number(match[1]);
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      match[2]
    ]!;
    return value * unitMs;
  }

  private assertActive(user: Pick<User, 'status'>) {
    if (user.status !== 'active') {
      throw new ForbiddenException('Account is not active');
    }
  }

  private async inferCountryFromPhone(
    phone: string,
    explicit?: string,
  ): Promise<string> {
    const fromDto = normalizeCountryCode(explicit);
    if (fromDto) {
      const country = await this.prisma.countryConfig.findFirst({
        where: { code: fromDto, active: true },
        select: { code: true },
      });
      if (!country) throw new BadRequestException('Unknown or inactive country');
      return country.code;
    }
    const countries = await this.prisma.countryConfig.findMany({
      where: { active: true },
      select: { code: true, phoneCallingCode: true },
    });
    const match = countries
      .sort((a, b) => b.phoneCallingCode.length - a.phoneCallingCode.length)
      .find((c) => phone.startsWith(c.phoneCallingCode));
    if (!match) {
      throw new BadRequestException(
        'countryCode is required — phone prefix did not match an active market',
      );
    }
    return match.code;
  }

  // ---------- Phone-OTP (primary player auth) ----------

  async requestOtp(phone: string): Promise<{ purpose: OtpPurpose }> {
    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
    });
    const purpose: OtpPurpose = existingUser ? 'login' : 'register';

    const recentCount = await this.prisma.otpCode.count({
      where: {
        target: phone,
        createdAt: { gt: new Date(Date.now() - 60_000) },
      },
    });
    if (recentCount >= 1) {
      throw new BadRequestException(
        'Please wait before requesting another code',
      );
    }

    const code = generateOtp();
    const codeHash = await bcrypt.hash(code, 10);
    const ttlSeconds = this.config.get<number>('OTP_TTL_SECONDS', 300);

    await this.prisma.otpCode.create({
      data: {
        userId: existingUser?.id,
        target: phone,
        codeHash,
        purpose,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });

    // Delivered out-of-band only — the code is NEVER returned in this method's result.
    await this.otpDelivery.send(phone, code);

    return { purpose };
  }

  async verifyOtp(
    dto: VerifyOtpDto,
  ): Promise<TokenPair & { user: Partial<User> }> {
    const otp = await this.prisma.otpCode.findFirst({
      where: {
        target: dto.phone,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp)
      throw new UnauthorizedException(
        'Code expired or not found, request a new one',
      );
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw new UnauthorizedException('Too many attempts, request a new code');
    }

    const isValid = this.otpDelivery.verify
      ? await this.otpDelivery.verify(dto.phone, dto.code)
      : await bcrypt.compare(dto.code, otp.codeHash);
    if (!isValid) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Invalid code');
    }

    await this.prisma.otpCode.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });

    let user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
    });
    if (!user) {
      if (!dto.name)
        throw new BadRequestException('name is required for a new account');
      const countryCode = await this.inferCountryFromPhone(
        dto.phone,
        dto.countryCode,
      );
      let referredById: string | undefined;
      if (dto.referralCode) {
        const referrer = await this.prisma.user.findUnique({
          where: { referralCode: dto.referralCode },
          select: { id: true },
        });
        referredById = referrer?.id;
      }
      user = await this.prisma.user.create({
        data: {
          phone: dto.phone,
          name: dto.name,
          roles: ['player'],
          countryCode,
          referredById,
        },
      });
    }
    this.assertActive(user);

    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  // ---------- Email/password (owner, staff, admin) ----------

  async registerOwner(
    dto: RegisterOwnerDto,
  ): Promise<TokenPair & { user: Partial<User> }> {
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: dto.email }, ...(dto.phone ? [{ phone: dto.phone }] : [])],
      },
    });
    if (existing) throw new ConflictException('Email or phone already in use');

    const countryCode = dto.phone
      ? await this.inferCountryFromPhone(dto.phone, dto.countryCode)
      : normalizeCountryCode(dto.countryCode) || 'EG';
    const passwordHash = await this.hashPassword(dto.password);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        name: dto.name,
        passwordHash,
        roles: ['owner'],
        countryCode,
      },
    });

    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  // ---------- Email/password (player, phone optional) ----------

  async requestEmailRegistrationOtp(rawEmail: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Email already in use');

    const recentCount = await this.prisma.otpCode.count({
      where: {
        target: email,
        purpose: OtpPurpose.register,
        createdAt: { gt: new Date(Date.now() - 60_000) },
      },
    });
    if (recentCount >= 1) {
      throw new BadRequestException(
        'Please wait before requesting another code',
      );
    }

    const code = generateOtp();
    const codeHash = await bcrypt.hash(code, 10);
    const ttlSeconds = this.config.get<number>('OTP_TTL_SECONDS', 300);
    await this.prisma.otpCode.create({
      data: {
        target: email,
        codeHash,
        purpose: OtpPurpose.register,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });
    await this.email.sendVerificationCode(
      email,
      code,
      Math.ceil(ttlSeconds / 60),
    );
  }

  async registerPlayerEmail(
    dto: RegisterEmailDto,
  ): Promise<TokenPair & { user: Partial<User> }> {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ email }, ...(dto.phone ? [{ phone: dto.phone }] : [])],
      },
    });
    if (existing) throw new ConflictException('Email or phone already in use');

    const otp = await this.prisma.otpCode.findFirst({
      where: {
        target: email,
        purpose: OtpPurpose.register,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new UnauthorizedException('Code expired or not found');
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw new UnauthorizedException('Too many attempts, request a new code');
    }
    if (!(await bcrypt.compare(dto.code, otp.codeHash))) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Invalid code');
    }

    const countryCode = dto.phone
      ? await this.inferCountryFromPhone(dto.phone, dto.countryCode)
      : normalizeCountryCode(dto.countryCode) || 'EG';
    const passwordHash = await this.hashPassword(dto.password);
    const [user] = await this.prisma.$transaction([
      this.prisma.user.create({
        data: {
          email,
          emailVerifiedAt: new Date(),
          phone: dto.phone,
          name: dto.name,
          passwordHash,
          roles: ['player'],
          countryCode,
        },
      }),
      this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { consumedAt: new Date() },
      }),
    ]);

    await this.email.sendWelcome(email, dto.name).catch((error: unknown) => {
      this.logger.warn(
        `Account created but welcome email failed for ${email}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    });

    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  async registerPartner(
    dto: PartnerRegisterDto,
  ): Promise<TokenPair & { user: Partial<User> }> {
    const username = normalizeUsername(dto.username);
    if (!isValidUsername(dto.username)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'USERNAME_INVALID',
        'Username must start with a letter and be 4–30 letters, digits, dots or underscores',
      );
    }

    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: dto.email },
          ...(dto.phone ? [{ phone: dto.phone }] : []),
          { username },
        ],
      },
    });
    if (existing) {
      const samePhonePlayer =
        !!dto.phone &&
        existing.phone === dto.phone &&
        !existing.passwordHash &&
        existing.roles.includes('player') &&
        !existing.roles.includes('owner');
      if (!samePhonePlayer) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'ACCOUNT_EXISTS',
          'Email, phone or username already in use',
        );
      }
      const passwordHash = await this.hashPassword(dto.password);
      const countryCode = dto.phone
        ? await this.inferCountryFromPhone(dto.phone, dto.countryCode)
        : normalizeCountryCode(dto.countryCode) || 'EG';
      const upgraded = await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          email: dto.email,
          name: dto.name,
          username,
          passwordHash,
          countryCode,
          roles: { set: Array.from(new Set([...existing.roles, 'owner' as const])) },
        },
      });
      const tokens = await this.issueTokenPair(upgraded);
      return { ...tokens, user: this.sanitize(upgraded) };
    }

    const countryCode = dto.phone
      ? await this.inferCountryFromPhone(dto.phone, dto.countryCode)
      : normalizeCountryCode(dto.countryCode) || 'EG';
    const passwordHash = await this.hashPassword(dto.password);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        name: dto.name,
        username,
        passwordHash,
        roles: ['owner'],
        countryCode,
      },
    });
    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  async loginEmail(
    dto: LoginEmailDto,
  ): Promise<TokenPair & { user: Partial<User> }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user?.passwordHash)
      throw new UnauthorizedException('Invalid credentials');
    this.assertActive(user);

    const isValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isValid) throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  async loginPartner(
    dto: PartnerLoginDto,
  ): Promise<TokenPair & { user: Partial<User> }> {
    const user = dto.username
      ? await this.prisma.user.findUnique({
          where: { username: normalizeUsername(dto.username) },
        })
      : await this.prisma.user.findUnique({
          where: { email: dto.email! },
        });
    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    this.assertActive(user);
    const isValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isValid) throw new UnauthorizedException('Invalid credentials');
    const isPartner = user.roles.some((r) =>
      ['owner', 'staff', 'admin'].includes(r),
    );
    if (!isPartner) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'NOT_A_PARTNER',
        'This account is not a venue partner',
      );
    }
    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  // ---------- Password reset (email or phone OTP, never leaks the code) ----------

  async requestPasswordReset(identifier: ForgotPasswordDto): Promise<void> {
    const target = this.passwordResetTarget(identifier);
    const user = await this.prisma.user.findUnique({
      where: identifier.email ? { email: target } : { phone: target },
    });
    if (!user) return;

    const recentCount = await this.prisma.otpCode.count({
      where: {
        target,
        purpose: 'reset_password',
        createdAt: { gt: new Date(Date.now() - 60_000) },
      },
    });
    if (recentCount >= 1) {
      throw new BadRequestException(
        'Please wait before requesting another code',
      );
    }

    const code = generateOtp();
    const codeHash = await bcrypt.hash(code, 10);
    const ttlSeconds = this.config.get<number>('OTP_TTL_SECONDS', 300);

    await this.prisma.otpCode.create({
      data: {
        userId: user.id,
        target,
        codeHash,
        purpose: 'reset_password',
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });
    if (identifier.email) {
      await this.email.sendPasswordResetCode(
        target,
        code,
        Math.ceil(ttlSeconds / 60),
      );
    } else {
      await this.otpDelivery.send(target, code);
    }
  }

  async resetPassword(
    identifier: ForgotPasswordDto,
    code: string,
    newPassword: string,
  ): Promise<void> {
    const target = this.passwordResetTarget(identifier);
    const otp = await this.prisma.otpCode.findFirst({
      where: {
        target,
        purpose: 'reset_password',
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new UnauthorizedException('Code expired or not found');
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw new UnauthorizedException('Too many attempts, request a new code');
    }

    const isValid =
      identifier.phone && this.otpDelivery.verify
        ? await this.otpDelivery.verify(identifier.phone, code)
        : await bcrypt.compare(code, otp.codeHash);
    if (!isValid) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Invalid code');
    }

    const user = await this.prisma.user.findUnique({
      where: identifier.email ? { email: target } : { phone: target },
    });
    if (!user) throw new BadRequestException('Account not found');

    const passwordHash = await this.hashPassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    if (user.email) {
      await this.email.sendPasswordChanged(user.email).catch((error: unknown) => {
        this.logger.warn(
          `Password changed but security email failed for ${user.email}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
    }
  }

  private passwordResetTarget(identifier: ForgotPasswordDto): string {
    if (!!identifier.phone === !!identifier.email) {
      throw new BadRequestException('Provide exactly one of phone or email');
    }
    return identifier.email
      ? identifier.email.trim().toLowerCase()
      : identifier.phone!;
  }

  // ---------- Refresh / logout ----------

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: { sub: string };
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenHash = this.sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) throw new UnauthorizedException('Invalid refresh token');
    this.assertActive(user);

    // rotate: revoke the used token, issue a brand-new pair
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokenPair(user, stored.deviceInfo ?? undefined);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: { userId: true },
    });
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Signing out ends the voice lobby too. Doing it server-side means it also
    // holds when the tab is closed mid-request or the client never gets to run
    // its own teardown.
    if (stored) await this.squad.leaveCurrentSquad(stored.userId).catch(() => undefined);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * "Play as guest" from a squad invite link: validates the link first (so no
   * junk accounts are minted for dead links), creates a throw-away player and
   * seats it in the squad. The nickname is optional; without one the guest
   * gets a neutral "Guest 1234" label. Cleaned up by SquadService.sweepGuests.
   */
  async joinSquadAsGuest(
    dto: GuestJoinDto,
    deviceInfo?: string,
  ): Promise<TokenPair & { user: Partial<User>; squadId: string }> {
    await this.squad.previewInviteLink(dto.token); // 404 for bad/expired, 409-free
    const lang = dto.lang === 'en' ? 'en' : 'ar';
    // Strip control/bidi-override characters and collapse whitespace.
    const cleaned = (dto.name ?? '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24);
    const suffix = String(1000 + Math.floor(Math.random() * 9000));
    const name = cleaned || (lang === 'ar' ? `ضيف ${suffix}` : `Guest ${suffix}`);

    const user = await this.prisma.user.create({
      data: { name, isGuest: true, roles: ['player'], preferredLang: lang },
    });
    try {
      const joined = await this.squad.joinViaInviteLink(user.id, dto.token);
      const tokens = await this.issueTokenPair(user, deviceInfo);
      return { ...tokens, user: this.sanitize(user), squadId: joined.squadId };
    } catch (err) {
      // Full squad / link died in between: do not leave an orphan guest.
      await this.prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
      throw err;
    }
  }

  private sanitize(user: User): Partial<User> {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
  }

  /** Used by WebAuthn and other sibling auth flows. */
  assertAccountActive(user: Pick<User, 'status'>): void {
    this.assertActive(user);
  }

  issueSession(
    user: Pick<User, 'id' | 'phone' | 'email' | 'name' | 'roles' | 'countryCode'>,
    deviceInfo?: string,
  ): Promise<TokenPair> {
    return this.issueTokenPair(user, deviceInfo);
  }

  publicUser(user: User): Partial<User> {
    return this.sanitize(user);
  }

  listLoginProviders(): {
    google: { enabled: boolean; clientId?: string };
    facebook: { enabled: boolean; appId?: string };
    passkeys: { enabled: boolean };
  } {
    const google = this.config.get<string>('GOOGLE_CLIENT_ID')?.trim() || '';
    const facebook = this.config.get<string>('FACEBOOK_APP_ID')?.trim() || '';
    const facebookSecret =
      this.config.get<string>('FACEBOOK_APP_SECRET')?.trim() || '';
    return {
      google: { enabled: !!google, clientId: google || undefined },
      facebook: {
        enabled: !!facebook && !!facebookSecret,
        appId: facebook || undefined,
      },
      passkeys: { enabled: true },
    };
  }

  // ---------- OAuth (wired, inert until client IDs are configured) ----------

  async oauthGoogle(
    dto: OAuthGoogleDto,
  ): Promise<TokenPair & { user: Partial<User> }> {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID')?.trim();
    if (!clientId) {
      throw new NotImplementedException(
        'Google sign-in is not configured yet — set GOOGLE_CLIENT_ID in .env',
      );
    }

    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(dto.idToken)}`,
    );
    if (!response.ok) throw new UnauthorizedException('Invalid Google token');
    const claims = (await response.json()) as {
      aud: string;
      email?: string;
      email_verified?: string | boolean;
      name?: string;
      picture?: string;
      sub: string;
      nonce?: string;
    };

    const allowed = clientId
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (!allowed.includes(claims.aud)) {
      throw new UnauthorizedException('Token audience mismatch');
    }
    if (dto.nonce && claims.nonce && dto.nonce !== claims.nonce) {
      throw new UnauthorizedException('Token nonce mismatch');
    }
    const verified =
      claims.email_verified === true || claims.email_verified === 'true';
    if (!claims.email || !verified) {
      throw new BadRequestException('Google account has no verified email');
    }

    const user = await this.findOrCreateOAuthUser({
      provider: 'google',
      providerUserId: claims.sub,
      email: claims.email,
      name: claims.name ?? 'Player',
      avatarUrl: claims.picture,
    });
    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  async oauthFacebook(
    dto: OAuthFacebookDto,
  ): Promise<TokenPair & { user: Partial<User> }> {
    const appId = this.config.get<string>('FACEBOOK_APP_ID')?.trim();
    const appSecret = this.config.get<string>('FACEBOOK_APP_SECRET')?.trim();
    if (!appId || !appSecret) {
      throw new NotImplementedException(
        'Facebook sign-in is not configured yet — set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in .env',
      );
    }

    const debugUrl =
      `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(dto.accessToken)}` +
      `&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`;
    const debugRes = await fetch(debugUrl);
    if (!debugRes.ok) throw new UnauthorizedException('Invalid Facebook token');
    const debugJson = (await debugRes.json()) as {
      data?: { app_id?: string; is_valid?: boolean; user_id?: string };
    };
    if (!debugJson.data?.is_valid || debugJson.data.app_id !== appId) {
      throw new UnauthorizedException('Invalid Facebook token');
    }

    const meRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email,picture.type(large)&access_token=${encodeURIComponent(dto.accessToken)}`,
    );
    if (!meRes.ok) throw new UnauthorizedException('Invalid Facebook token');
    const me = (await meRes.json()) as {
      id: string;
      name?: string;
      email?: string;
      picture?: { data?: { url?: string } };
    };
    if (!me.id) throw new UnauthorizedException('Invalid Facebook token');

    const user = await this.findOrCreateOAuthUser({
      provider: 'facebook',
      providerUserId: me.id,
      email: me.email,
      name: me.name ?? 'Player',
      avatarUrl: me.picture?.data?.url,
    });
    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  private async findOrCreateOAuthUser(input: {
    provider: OAuthProvider;
    providerUserId: string;
    email?: string;
    name: string;
    avatarUrl?: string;
  }): Promise<User> {
    const linked = await this.prisma.oAuthIdentity.findUnique({
      where: {
        provider_providerUserId: {
          provider: input.provider,
          providerUserId: input.providerUserId,
        },
      },
      include: { user: true },
    });
    if (linked?.user) {
      this.assertActive(linked.user);
      if (
        (input.avatarUrl && !linked.user.avatarUrl) ||
        (input.email && !linked.user.emailVerifiedAt)
      ) {
        return this.prisma.user.update({
          where: { id: linked.user.id },
          data: {
            ...(input.avatarUrl && !linked.user.avatarUrl
              ? { avatarUrl: input.avatarUrl }
              : {}),
            ...(input.email && !linked.user.emailVerifiedAt
              ? { emailVerifiedAt: new Date() }
              : {}),
          },
        });
      }
      return linked.user;
    }

    const email = input.email?.trim().toLowerCase() || undefined;
    const existing = email
      ? await this.prisma.user.findUnique({ where: { email } })
      : null;

    if (existing) {
      this.assertActive(existing);
      await this.prisma.oAuthIdentity.create({
        data: {
          userId: existing.id,
          provider: input.provider,
          providerUserId: input.providerUserId,
          email,
        },
      });
      if (
        (input.avatarUrl && !existing.avatarUrl) ||
        (email && !existing.emailVerifiedAt)
      ) {
        return this.prisma.user.update({
          where: { id: existing.id },
          data: {
            ...(input.avatarUrl && !existing.avatarUrl
              ? { avatarUrl: input.avatarUrl }
              : {}),
            ...(email && !existing.emailVerifiedAt
              ? { emailVerifiedAt: new Date() }
              : {}),
          },
        });
      }
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: email ?? `${input.provider}-${input.providerUserId}@oauth.matchena.local`,
          emailVerifiedAt: email ? new Date() : undefined,
          phone: `pending-${crypto.randomUUID()}`,
          name: input.name,
          avatarUrl: input.avatarUrl,
          roles: ['player'],
        },
      });
      await tx.oAuthIdentity.create({
        data: {
          userId: user.id,
          provider: input.provider,
          providerUserId: input.providerUserId,
          email,
        },
      });
      return user;
    });
  }
}
