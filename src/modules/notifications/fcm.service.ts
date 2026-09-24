import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JWT } from 'google-auth-library';
import { PrismaService } from '../prisma/prisma.service';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface FcmMessage {
  title: string;
  body?: string | null;
  deepLink?: string | null;
  ctaUrl?: string | null;
}

/**
 * Native push (Android + iOS) over Firebase Cloud Messaging HTTP v1.
 *
 * Configured with `FIREBASE_SERVICE_ACCOUNT` — the service-account JSON from
 * Firebase console → Project settings → Service accounts, pasted raw or
 * base64-encoded. Without it every call is a no-op. (The legacy
 * `fcm/send` + server-key API was shut down by Google in 2024.)
 */
@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);
  private readonly account: ServiceAccount | null;
  private readonly client: JWT | null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.account = parseServiceAccount(config.get<string>('FIREBASE_SERVICE_ACCOUNT'));
    this.client = this.account
      ? new JWT({
          email: this.account.client_email,
          key: this.account.private_key,
          scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
        })
      : null;
    if (config.get<string>('FIREBASE_SERVICE_ACCOUNT') && !this.account) {
      this.logger.error('FIREBASE_SERVICE_ACCOUNT is set but is not a valid service-account JSON');
    }
  }

  configured(): boolean {
    return !!this.client;
  }

  /** Fire-and-forget from NotificationsService.create; never throws. */
  async sendToUser(userId: string, message: FcmMessage): Promise<void> {
    if (!this.client || !this.account) return;
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { id: true, token: true, platform: true },
    });
    if (!tokens.length) return;
    let accessToken: string | null | undefined;
    try {
      accessToken = (await this.client.getAccessToken()).token;
    } catch (err) {
      this.logger.warn(`FCM auth failed: ${String(err)}`);
      return;
    }
    if (!accessToken) return;
    const url = `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`;
    await Promise.all(
      tokens.map(async (device) => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: buildMessage(device.token, message) }),
          });
          if (res.ok) return;
          const detail = await res.text();
          if (res.status === 404 || /UNREGISTERED|registration-token-not-registered/i.test(detail) ||
              (res.status === 400 && /INVALID_ARGUMENT/.test(detail) && /token/i.test(detail))) {
            // App uninstalled, signed out (token deleted) or token rotated.
            await this.prisma.deviceToken.delete({ where: { id: device.id } }).catch(() => undefined);
          } else {
            this.logger.warn(`FCM send failed (${res.status}): ${detail.slice(0, 300)}`);
          }
        } catch (err) {
          this.logger.warn(`FCM send failed: ${String(err)}`);
        }
      }),
    );
  }
}

export function buildMessage(token: string, message: FcmMessage) {
  const data: Record<string, string> = {};
  if (message.deepLink) data['deepLink'] = message.deepLink;
  if (message.ctaUrl) data['ctaUrl'] = message.ctaUrl;
  return {
    token,
    notification: { title: message.title, body: message.body || message.title },
    data,
    android: {
      priority: 'HIGH',
      notification: { channel_id: 'matchena_default', sound: 'default' },
    },
    apns: { payload: { aps: { sound: 'default' } } },
  };
}

export function parseServiceAccount(raw?: string | null): ServiceAccount | null {
  if (!raw?.trim()) return null;
  const text = raw.trim().startsWith('{') ? raw.trim() : Buffer.from(raw.trim(), 'base64').toString('utf8');
  try {
    const json = JSON.parse(text) as Partial<ServiceAccount>;
    if (!json.project_id || !json.client_email || !json.private_key) return null;
    // Env editors often store the key with literal "\n" sequences.
    return { project_id: json.project_id, client_email: json.client_email, private_key: json.private_key.replace(/\\n/g, '\n') };
  } catch {
    return null;
  }
}
