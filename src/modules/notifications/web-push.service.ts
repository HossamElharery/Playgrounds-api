import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

export interface WebPushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

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

  async unsubscribe(userId: string, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
    return { ok: true };
  }

  async send(userId: string, title: string, body?: string, url?: string): Promise<void> {
    await this.deliver(userId, JSON.stringify({ title, body: body ?? title, url: url ?? '/' }));
  }

  async sendCall(
    userId: string,
    call: { callId: string; kind: 'ring' | 'missed'; title: string; body?: string | null; url: string },
  ): Promise<void> {
    const ring = call.kind === 'ring';
    await this.deliver(
      userId,
      JSON.stringify({
        title: call.title,
        body: call.body || call.title,
        url: call.url,
        tag: `call:${call.callId}`,
        kind: call.kind,
        callId: call.callId,
        requireInteraction: ring,
        renotify: true,
      }),
      { TTL: ring ? 30 : 86_400, urgency: 'high' },
    );
  }

  private async deliver(userId: string, payload: string, options?: webpush.RequestOptions): Promise<void> {
    if (!this.ready) return;
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    if (!subs.length) return;
    await Promise.all(
      subs.map(async (sub) => {
        try {
          const target = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
          if (options) await webpush.sendNotification(target, payload, options);
          else await webpush.sendNotification(target, payload);
          await this.prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
        } catch (err) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
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
