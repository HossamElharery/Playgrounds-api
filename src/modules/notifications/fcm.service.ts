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

export interface FcmCallMessage {
  callId: string;
  kind: 'ring' | 'missed';
  title: string;
  body?: string | null;
  deepLink: string;
}

export const CALL_CHANNEL_ID = 'matchena_calls';
export const CALL_PUSH_TTL_S = 30;

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
    if (!config.get<string>('FIREBASE_SERVICE_ACCOUNT') && config.get<string>('NODE_ENV') === 'production') {
      // Without it no phone push is ever sent: calls and booking notices only reach people with the app open.
      this.logger.error('FIREBASE_SERVICE_ACCOUNT is not set: mobile push notifications and call rings are disabled');
    }
    if (config.get<string>('FIREBASE_SERVICE_ACCOUNT') && !this.account) {
      this.logger.error('FIREBASE_SERVICE_ACCOUNT is set but is not a valid service-account JSON');
    }
  }

  configured(): boolean {
    return !!this.client;
  }

  async sendToUser(userId: string, message: FcmMessage): Promise<void> {
    await this.deliver(userId, (device) => buildMessage(device.token, message));
  }

  /**
   * Rings or reports a call. Returns how many devices FCM accepted the message for (0 when push is
   * not configured or the person has no device), so the caller can tell "pushed" from "nobody to push to".
   * Android builds with the native call screen get a data-only message that their app turns into a
   * full-screen incoming call; every other device gets the ordinary notification.
   */
  async sendCall(userId: string, message: FcmCallMessage): Promise<number> {
    return this.deliver(userId, (device) =>
      message.kind === 'ring' && isNativeCallDevice(device)
        ? buildNativeCallMessage(device.token, message)
        : buildCallMessage(device.token, message),
    );
  }

  /** Stops a ringing call screen on the person's Android devices (the call ended or was answered). */
  async sendCallCancel(userId: string, callId: string): Promise<number> {
    return this.deliver(userId, (device) => (isNativeCallDevice(device) ? buildNativeCallCancel(device.token, callId) : null));
  }

  private async deliver(userId: string, build: (device: DeviceInfo) => object | null): Promise<number> {
    if (!this.client || !this.account) return 0;
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { id: true, token: true, platform: true, capabilities: true },
    });
    if (!tokens.length) return 0;
    let accessToken: string | null | undefined;
    try {
      accessToken = (await this.client.getAccessToken()).token;
    } catch (err) {
      this.logger.warn(`FCM auth failed: ${String(err)}`);
      return 0;
    }
    if (!accessToken) return 0;
    const url = `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`;
    let accepted = 0;
    await Promise.all(
      tokens.map(async (device) => {
        const message = build(device);
        if (!message) return;
        try {
          const res = await sendWithRetry(() =>
            fetch(url, {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ message }),
            }),
          );
          if (res.ok) {
            accepted += 1;
            return;
          }
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
    return accepted;
  }
}

interface DeviceInfo {
  token: string;
  platform: string;
  capabilities: string[];
}

export function isNativeCallDevice(device: Pick<DeviceInfo, 'platform' | 'capabilities'>): boolean {
  return device.platform === 'android' && (device.capabilities ?? []).includes('native-call-ui');
}

/**
 * Data-only, high priority: the Android app (not the system tray) handles it and shows the
 * full-screen incoming call. Short TTL, so a phone that comes online late does not ring for a dead call.
 */
export function buildNativeCallMessage(token: string, message: FcmCallMessage) {
  return {
    token,
    data: {
      type: 'call',
      kind: 'ring',
      callId: message.callId,
      title: message.title,
      body: message.body || message.title,
      deepLink: message.deepLink,
    },
    android: { priority: 'HIGH', ttl: `${CALL_PUSH_TTL_S}s`, collapse_key: `call:${message.callId}` },
  };
}

export function buildNativeCallCancel(token: string, callId: string) {
  return {
    token,
    data: { type: 'call', kind: 'cancel', callId },
    android: { priority: 'HIGH', ttl: '60s', collapse_key: `call:${callId}` },
  };
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
          sound: ring ? 'matchena_ring.wav' : 'default',
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

const RETRY_DELAYS_MS = [300, 1_200];

/**
 * FCM answers 429/5xx (and sometimes drops the connection) during incidents. A
 * short bounded retry rescues most of those without holding the request open;
 * 4xx answers are final and handled by the caller (dead tokens are deleted).
 */
export async function sendWithRetry(
  send: () => Promise<Response>,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await send();
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt >= delays.length) return res;
    } catch (error) {
      if (attempt >= delays.length) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
}
