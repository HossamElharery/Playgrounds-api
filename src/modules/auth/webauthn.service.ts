import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, TokenPair } from './auth.service';
import { WebAuthnVerifyDto } from './dto/webauthn.dto';
import { User } from '@prisma/client';

type ChallengePurpose = 'webauthn_register' | 'webauthn_auth';

interface ChallengePayload {
  purpose: ChallengePurpose;
  challenge: string;
  sub?: string;
}

export interface PasskeyPublic {
  id: string;
  friendlyName: string | null;
  deviceType: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

@Injectable()
export class WebAuthnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  private rpID(): string {
    const explicit = this.config.get<string>('WEBAUTHN_RP_ID');
    if (explicit) return explicit;
    if (this.config.get<string>('NODE_ENV') === 'production') {
      try {
        return new URL(this.config.get<string>('SITE_URL', 'https://matchena.com'))
          .hostname.replace(/^www\./, '');
      } catch {
        return 'matchena.com';
      }
    }
    return 'localhost';
  }

  private rpName(): string {
    return this.config.get<string>('WEBAUTHN_RP_NAME', 'Matchena');
  }

  private origins(): string[] {
    const explicit = this.config.get<string>('WEBAUTHN_ORIGINS');
    const raw = explicit || this.config.get<string>('CORS_ORIGINS', 'http://localhost:4200');
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private challengeSecret(): string {
    return this.config.get<string>('JWT_ACCESS_SECRET')!;
  }

  private async signChallenge(
    purpose: ChallengePurpose,
    challenge: string,
    userId?: string,
  ): Promise<string> {
    const payload: ChallengePayload = { purpose, challenge };
    if (userId) payload.sub = userId;
    return this.jwt.signAsync(payload, {
      secret: this.challengeSecret(),
      expiresIn: '5m',
    });
  }

  private async readChallenge(
    token: string,
    purpose: ChallengePurpose,
  ): Promise<ChallengePayload> {
    try {
      const payload = await this.jwt.verifyAsync<ChallengePayload>(token, {
        secret: this.challengeSecret(),
      });
      if (payload.purpose !== purpose || !payload.challenge) {
        throw new UnauthorizedException('Invalid passkey challenge');
      }
      return payload;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Passkey challenge expired, try again');
    }
  }

  async registrationOptions(user: Pick<User, 'id' | 'email' | 'name' | 'phone'>): Promise<{
    options: PublicKeyCredentialCreationOptionsJSON;
    challengeToken: string;
  }> {
    const existing = await this.prisma.webAuthnCredential.findMany({
      where: { userId: user.id },
      select: { credentialId: true, transports: true },
    });

    const options = await generateRegistrationOptions({
      rpName: this.rpName(),
      rpID: this.rpID(),
      userName: user.email || user.phone || user.id,
      userID: new TextEncoder().encode(user.id),
      userDisplayName: user.name,
      attestationType: 'none',
      excludeCredentials: existing.map((row) => ({
        id: row.credentialId,
        transports: row.transports,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
        authenticatorAttachment: 'platform',
      },
      preferredAuthenticatorType: 'localDevice',
    });

    const challengeToken = await this.signChallenge(
      'webauthn_register',
      options.challenge,
      user.id,
    );
    return { options, challengeToken };
  }

  async verifyRegistration(
    user: Pick<User, 'id'>,
    dto: WebAuthnVerifyDto,
  ): Promise<PasskeyPublic> {
    const challenge = await this.readChallenge(dto.challengeToken, 'webauthn_register');
    if (challenge.sub !== user.id) {
      throw new UnauthorizedException('Passkey challenge mismatch');
    }

    const verification = await verifyRegistrationResponse({
      response: dto.credential as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.origins(),
      expectedRPID: this.rpID(),
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new UnauthorizedException('Could not verify this device');
    }

    const { credential, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;

    const saved = await this.prisma.webAuthnCredential.create({
      data: {
        userId: user.id,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        transports: credential.transports ?? [],
        friendlyName: dto.friendlyName?.slice(0, 80) || null,
      },
    });

    return this.toPublic(saved);
  }

  async authenticationOptions(): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
    challengeToken: string;
  }> {
    const options = await generateAuthenticationOptions({
      rpID: this.rpID(),
      userVerification: 'required',
    });
    options.hints = ['client-device'];
    const challengeToken = await this.signChallenge(
      'webauthn_auth',
      options.challenge,
    );
    return { options, challengeToken };
  }

  async verifyAuthentication(
    dto: WebAuthnVerifyDto,
  ): Promise<TokenPair & { user: Partial<User> }> {
    const challenge = await this.readChallenge(dto.challengeToken, 'webauthn_auth');
    const response = dto.credential as unknown as AuthenticationResponseJSON;
    if (!response?.id) throw new BadRequestException('Invalid passkey response');

    const stored = await this.prisma.webAuthnCredential.findUnique({
      where: { credentialId: response.id },
    });
    if (!stored) throw new UnauthorizedException('Unknown passkey');

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.origins(),
      expectedRPID: this.rpID(),
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(stored.publicKey),
        counter: Number(stored.counter),
        transports: stored.transports,
      },
      requireUserVerification: true,
    });

    if (!verification.verified) {
      throw new UnauthorizedException('Could not verify this device');
    }

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user) throw new UnauthorizedException('Unknown passkey');
    this.auth.assertAccountActive(user);

    await this.prisma.webAuthnCredential.update({
      where: { id: stored.id },
      data: {
        counter: BigInt(verification.authenticationInfo.newCounter),
        lastUsedAt: new Date(),
        backedUp: verification.authenticationInfo.credentialBackedUp,
        deviceType: verification.authenticationInfo.credentialDeviceType,
      },
    });

    const tokens = await this.auth.issueSession(user, dto.friendlyName);
    return { ...tokens, user: this.auth.publicUser(user) };
  }

  async list(userId: string): Promise<PasskeyPublic[]> {
    const rows = await this.prisma.webAuthnCredential.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toPublic(row));
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.prisma.webAuthnCredential.deleteMany({
      where: { id, userId },
    });
    if (result.count === 0) throw new BadRequestException('Passkey not found');
  }

  private toPublic(row: {
    id: string;
    friendlyName: string | null;
    deviceType: string | null;
    createdAt: Date;
    lastUsedAt: Date | null;
  }): PasskeyPublic {
    return {
      id: row.id,
      friendlyName: row.friendlyName,
      deviceType: row.deviceType,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    };
  }
}
