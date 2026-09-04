import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotImplementedException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { OTP_DELIVERY, OtpDelivery } from '../sms/otp-delivery.interface';
import { generateOtp } from '../../common/utils/otp.util';
import { OtpPurpose, User } from '@prisma/client';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { LoginEmailDto } from './dto/login-email.dto';
import { RegisterOwnerDto } from './dto/register-owner.dto';
import { OAuthGoogleDto } from './dto/oauth-google.dto';
import { OAuthAppleDto } from './dto/oauth-apple.dto';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    @Inject(OTP_DELIVERY) private readonly otpDelivery: OtpDelivery,
  ) {}

  // ---------- password / token primitives ----------

  private hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, this.config.get<number>('SALT_ROUNDS', 10));
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private async issueTokenPair(user: Pick<User, 'id' | 'phone' | 'email' | 'name' | 'roles'>, deviceInfo?: string): Promise<TokenPair> {
    const payload = {
      id: user.id,
      phone: user.phone,
      email: user.email,
      name: user.name,
      roles: user.roles,
    };

    const accessExpiresIn = this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m');
    const refreshExpiresIn = this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '7d');

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: accessExpiresIn,
    });

    const refreshToken = await this.jwtService.signAsync(
      { sub: user.id, jti: crypto.randomUUID() },
      { secret: this.config.get<string>('JWT_REFRESH_SECRET'), expiresIn: refreshExpiresIn },
    );

    const expiresAt = new Date(Date.now() + this.parseDurationMs(refreshExpiresIn));
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
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]!;
    return value * unitMs;
  }

  // ---------- Phone-OTP (primary player auth) ----------

  async requestOtp(phone: string): Promise<{ purpose: OtpPurpose }> {
    const existingUser = await this.prisma.user.findUnique({ where: { phone } });
    const purpose: OtpPurpose = existingUser ? 'login' : 'register';

    const recentCount = await this.prisma.otpCode.count({
      where: { target: phone, createdAt: { gt: new Date(Date.now() - 60_000) } },
    });
    if (recentCount >= 1) {
      throw new BadRequestException('Please wait before requesting another code');
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

  async verifyOtp(dto: VerifyOtpDto): Promise<TokenPair & { user: Partial<User> }> {
    const otp = await this.prisma.otpCode.findFirst({
      where: { target: dto.phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) throw new UnauthorizedException('Code expired or not found, request a new one');
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw new UnauthorizedException('Too many attempts, request a new code');
    }

    const isValid = await bcrypt.compare(dto.code, otp.codeHash);
    if (!isValid) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Invalid code');
    }

    await this.prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });

    let user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (!user) {
      if (!dto.name) throw new BadRequestException('name is required for a new account');
      user = await this.prisma.user.create({
        data: { phone: dto.phone, name: dto.name, roles: ['player'] },
      });
    }

    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  // ---------- Email/password (owner, staff, admin) ----------

  async registerOwner(dto: RegisterOwnerDto): Promise<TokenPair & { user: Partial<User> }> {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
    });
    if (existing) throw new ConflictException('Email or phone already in use');

    const passwordHash = await this.hashPassword(dto.password);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        name: dto.name,
        passwordHash,
        roles: ['owner'],
      },
    });

    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  async loginEmail(dto: LoginEmailDto): Promise<TokenPair & { user: Partial<User> }> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user?.passwordHash) throw new UnauthorizedException('Invalid credentials');

    const isValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isValid) throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  // ---------- Password reset (phone-OTP gated, never leaks the code) ----------

  async requestPasswordReset(phone: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) return; // do not reveal whether the phone is registered

    const code = generateOtp();
    const codeHash = await bcrypt.hash(code, 10);
    const ttlSeconds = this.config.get<number>('OTP_TTL_SECONDS', 300);

    await this.prisma.otpCode.create({
      data: {
        userId: user.id,
        target: phone,
        codeHash,
        purpose: 'reset_password',
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });
    await this.otpDelivery.send(phone, code);
  }

  async resetPassword(phone: string, code: string, newPassword: string): Promise<void> {
    const otp = await this.prisma.otpCode.findFirst({
      where: {
        target: phone,
        purpose: 'reset_password',
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new UnauthorizedException('Code expired or not found');

    const isValid = await bcrypt.compare(code, otp.codeHash);
    if (!isValid) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Invalid code');
    }

    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) throw new BadRequestException('Account not found');

    const passwordHash = await this.hashPassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } }),
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
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
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException('Invalid refresh token');

    // rotate: revoke the used token, issue a brand-new pair
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokenPair(user, stored.deviceInfo ?? undefined);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.sha256(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ---------- OAuth (wired, inert until client IDs are configured) ----------

  async oauthGoogle(dto: OAuthGoogleDto): Promise<TokenPair & { user: Partial<User> }> {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) {
      throw new NotImplementedException(
        'Google sign-in is not configured yet — set GOOGLE_CLIENT_ID in .env',
      );
    }

    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(dto.idToken)}`,
    );
    if (!response.ok) throw new UnauthorizedException('Invalid Google token');
    const claims = (await response.json()) as { aud: string; email?: string; name?: string; sub: string };

    if (claims.aud !== clientId) throw new UnauthorizedException('Token audience mismatch');
    if (!claims.email) throw new BadRequestException('Google account has no email');

    const user = await this.findOrCreateOAuthUser(claims.email, claims.name ?? 'Player');
    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  async oauthApple(dto: OAuthAppleDto): Promise<TokenPair & { user: Partial<User> }> {
    const clientId = this.config.get<string>('APPLE_CLIENT_ID');
    if (!clientId) {
      throw new NotImplementedException(
        'Apple sign-in is not configured yet — set APPLE_CLIENT_ID/APPLE_TEAM_ID/APPLE_KEY_ID in .env',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jwksClient = require('jwks-rsa') as typeof import('jwks-rsa');
    const client = jwksClient({ jwksUri: 'https://appleid.apple.com/auth/keys' });

    const decoded = jwt.decode(dto.identityToken, { complete: true });
    if (!decoded || typeof decoded === 'string') throw new UnauthorizedException('Invalid Apple token');
    const key = await client.getSigningKey(decoded.header.kid);
    const claims = jwt.verify(dto.identityToken, key.getPublicKey(), {
      audience: clientId,
      issuer: 'https://appleid.apple.com',
    }) as { email?: string; sub: string };

    const email = claims.email ?? `${claims.sub}@appleid.private`;
    const user = await this.findOrCreateOAuthUser(email, dto.name ?? 'Player');
    const tokens = await this.issueTokenPair(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  private async findOrCreateOAuthUser(email: string, name: string): Promise<User> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) return existing;

    return this.prisma.user.create({
      data: {
        email,
        phone: `pending-${crypto.randomUUID()}`, // player completes phone verification post-signup
        name,
        roles: ['player'],
      },
    });
  }

  private sanitize(user: User): Partial<User> {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
  }
}
