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

/** An incoming (or just-missed) staff call. Delivered on its own channel with a short life. */
export interface FcmCallMessage {
  callId: string;
  kind: 'ring' | 'missed';
  title: string;
  body?: string | null;
  deepLink: string;
}

/** Android channel the ringing notification uses (created by the app: loud, heads-up, vibrating). */
export const CALL_CHANNEL_ID = 'matchena_calls';
/** A ringing push older than this is worthless: the caller has given up. */
export const CALL_PUSH_TTL_S = 30;

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
    await this.deliver(userId, (token) => buildMessage(token, message));
  }

  /**
   * Staff-call push: a ringing notification (high priority, call channel, short TTL, time-sensitive
   * on iOS) or the "missed call" that replaces it (same tag / collapse id). Never throws.
   */
  async sendCall(userId: string, message: FcmCallMessage): Promise<void> {
    await this.deliver(userId, (token) => buildCallMessage(token, message));
  }

  private async deliver(userId: string, build: (token: string) => object): Promise<void> {
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
            body: JSON.stringify({ message: build(device.token) }),
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

export function buildCallMessage(token: string, message: FcmCallMessage, nowMs = Date.now()) {
  const ring = message.kind === 'ring';
  const tag = `call:${message.callId}`;
  return {
    token,
    notification: { title: message.title, body: message.body || message.title },
    data: { type: 'call', kind: message.kind, callId: message.callId, deepLink: message.deepLink },
    android: {
      priority: 'HIGH',
      // A missed call lives on; a ring that arrives late is dropped by FCM itself.
      ttl: ring ? `${CALL_PUSH_TTL_S}s` : '86400s',
      collapse_key: tag,
      notification: {
        channel_id: ring ? CALL_CHANNEL_ID : 'matchena_default',
        tag,
        sound: 'default',
        ...(ring ? { notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC', default_vibrate_timings: true } : {}),
      },
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-collapse-id': message.callId.slice(0, 64),
        ...(ring ? { 'apns-expiration': String(Math.floor(nowMs / 1000) + CALL_PUSH_TTL_S) } : {}),
      },
      payload: {
        aps: {
          // The 28 s ringtone ships inside the iOS app (ios/App/App/matchena_ring.wav); an older build falls back to the default tone.
          sound: ring ? 'matchena_ring.wav' : 'default',
          // Needs the time-sensitive entitlement (added with the iOS project); without it iOS treats it as active.
          'interruption-level': ring ? 'time-sensitive' : 'active',
        },
      },
    },
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
