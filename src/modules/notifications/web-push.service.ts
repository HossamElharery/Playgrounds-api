import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

export interface WebPushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

/**
 * Free browser push over VAPID. Off by default: with no `VAPID_*` env vars this service is a
 * no-op everywhere (the API tells the frontend so, and the frontend never shows the "enable"
 * button). Piggybacks on `NotificationsService.create` — no new send path, no new dedupe
 * logic, no new place a category preference could be forgotten.
 */
@Injectable()
export class WebPushService {
  private readonly logger = new Logger(WebPushService.name);
  private ready = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    if (this.configured()) {
      webpush.setVapidDetails(
        this.subject(),
        this.config.get<string>('VAPID_PUBLIC_KEY')!,
        this.config.get<string>('VAPID_PRIVATE_KEY')!,
      );
      this.ready = true;
    }
  }

  configured(): boolean {
    return !!(
      this.config.get<string>('VAPID_PUBLIC_KEY') &&
      this.config.get<string>('VAPID_PRIVATE_KEY') &&
      this.config.get<string>('VAPID_SUBJECT')
    );
  }

  /** `null` when the feature is off — the frontend never shows the "enable" button in that case. */
  publicKey(): string | null {
    return this.configured() ? this.config.get<string>('VAPID_PUBLIC_KEY')! : null;
  }

  async subscribe(userId: string, input: WebPushSubscriptionInput) {
    if (!this.configured()) throw new BadRequestException('Web Push is not configured');
    if (!input.endpoint || !input.keys?.p256dh || !input.keys?.auth) {
      throw new BadRequestException('A valid push subscription is required');
    }
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      update: { userId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: input.userAgent, lastUsedAt: new Date() },
      create: { userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: input.userAgent },
    });
    return { ok: true };
  }

  /** Scoped to the caller: one browser cannot unsubscribe another user's endpoint. */
  async unsubscribe(userId: string, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
    return { ok: true };
  }

  /**
   * Fire-and-forget from `NotificationsService.create`, after the same category/preference
   * check has already gated whether a notification was written at all. `title`/`body` are
   * exactly what was already stored (never richer), so nothing new can leak into a push
   * payload that a lock-screen shows to whoever glances at the phone.
   */
  async send(userId: string, title: string, body?: string, url?: string): Promise<void> {
    if (!this.ready) return;
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    if (!subs.length) return;
    const payload = JSON.stringify({ title, body: body ?? title, url: url ?? '/' });
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
          );
          await this.prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
        } catch (err) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            // The browser dropped this subscription (uninstalled, cleared data, expired) — stop trying it.
            await this.prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
          } else {
            this.logger.warn(`push send failed (${status ?? 'no status'}): ${String(err)}`);
          }
        }
      }),
    );
  }

  private subject(): string {
    const subject = this.config.get<string>('VAPID_SUBJECT')!;
    return /^(mailto:|https?:\/\/)/.test(subject) ? subject : `mailto:${subject}`;
  }
}
