import { Prisma } from '@prisma/client';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { paginateByCursor } from '../../common/pagination/cursor-pagination.dto';
import { UpdateNotificationPrefsDto } from './dto/device-token.dto';
import { sanitizeNotificationCtaUrl } from './cta-url';
import { WebPushService } from './web-push.service';
import { FcmService } from './fcm.service';

export interface CreateNotificationInput {
  userId: string;
  category: string;
  titleEn: string;
  titleAr: string;
  bodyEn?: string;
  bodyAr?: string;
  deepLink?: string;
  payload?: Record<string, unknown>;
}

const DEFAULT_PREFS: Record<string, boolean> = {
  chat: true,
  friends: true,
  matches: true,
  squad: true,
  teams: true,
  bookings: true,
  tournaments: true,
  rewards: true,
  pulse: true,
  posts: true,
  system: true,
  marketing: false,
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly config: ConfigService,
    private readonly webPush: WebPushService,
    private readonly fcm: FcmService,
  ) {}

  categoryEnabled(
    prefs: Record<string, boolean> | null | undefined,
    category: string,
  ): boolean {
    const merged = { ...DEFAULT_PREFS, ...(prefs ?? {}) };
    return merged[category] !== false;
  }

  async create(input: CreateNotificationInput) {
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { notificationPrefs: true, preferredLang: true },
    });
    const prefs = (user?.notificationPrefs ?? {}) as Record<string, boolean>;
    if (!this.categoryEnabled(prefs, input.category)) return null;

    const notification = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        category: input.category,
        titleEn: input.titleEn,
        titleAr: input.titleAr,
        bodyEn: input.bodyEn,
        bodyAr: input.bodyAr,
        deepLink: input.deepLink,
        payload: input.payload as object | undefined,
      },
    });
    this.emitter.emitToUser(input.userId, {
      type: 'notification.created',
      notification,
    });
    const ar = user?.preferredLang !== 'en';
    void this.fcm.sendToUser(input.userId, {
      title: ar ? input.titleAr : input.titleEn,
      body: ar ? input.bodyAr : input.bodyEn,
      deepLink: input.deepLink,
      ctaUrl: typeof input.payload?.['ctaUrl'] === 'string' ? (input.payload['ctaUrl'] as string) : undefined,
    });
    void this.webPush.send(
      input.userId,
      ar ? input.titleAr : input.titleEn,
      ar ? input.bodyAr : input.bodyEn,
      input.deepLink,
    );
    return notification;
  }

  list(userId: string, cursor?: string, limit = 30) {
    return paginateByCursor(
      (args) =>
        this.prisma.notification.findMany({
          where: { userId },
          orderBy: { id: 'desc' },
          ...args,
        }),
      limit,
      cursor,
    );
  }

  dismiss(userId: string, id: string) {
    return this.prisma.notification.deleteMany({ where: { id, userId } });
  }

  async markRead(userId: string, id: string) {
    return this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
  }

  unreadCount(userId: string) {
    return this.prisma.notification.count({ where: { userId, read: false } });
  }

  async getPreferences(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { notificationPrefs: true },
    });
    return { ...DEFAULT_PREFS, ...((user.notificationPrefs as object) ?? {}) };
  }

  async updatePreferences(userId: string, dto: UpdateNotificationPrefsDto) {
    const current = await this.getPreferences(userId);
    const next = {
      ...current,
      ...dto,
      ...(dto.extra ?? {}),
    };
    delete (next as { extra?: unknown }).extra;
    await this.prisma.user.update({
      where: { id: userId },
      data: { notificationPrefs: next },
    });
    return next;
  }

  async registerDevice(userId: string, token: string, platform = 'web') {
    // One phone, one owner: a token registered by another account on this
    // device must stop receiving that account's notifications.
    await this.prisma.deviceToken.deleteMany({ where: { token, userId: { not: userId } } });
    return this.prisma.deviceToken.upsert({
      where: { userId_token: { userId, token } },
      update: { platform, updatedAt: new Date() },
      create: { userId, token, platform },
    });
  }

  async unregisterDevice(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
  }

  async broadcast(input: {
    audience: 'owners' | 'players' | 'individual';
    recipientIds?: string[];
    governorateId?: string;
    districtId?: string;
    titleEn: string;
    titleAr: string;
    bodyEn: string;
    bodyAr: string;
    ctaLabelEn?: string;
    ctaLabelAr?: string;
    ctaUrl?: string;
  }) {
    const areaFilter: Prisma.UserWhereInput =
      input.audience === 'individual'
        ? {}
        : input.districtId
          ? { districtId: input.districtId }
          : input.governorateId
            ? { governorateId: input.governorateId }
            : {};
    const pickedIds = [
      ...new Set(
        (input.recipientIds ?? []).map((id) => id.trim()).filter(Boolean),
      ),
    ];
    if (input.audience === 'individual' && !pickedIds.length) {
      throw new BadRequestException('Select at least one recipient');
    }
    const where: Prisma.UserWhereInput =
      input.audience === 'owners'
        ? {
            roles: { has: 'owner' as const },
            status: 'active' as const,
            ...areaFilter,
          }
        : input.audience === 'players'
          ? {
              roles: { has: 'player' as const },
              NOT: { roles: { hasSome: ['owner', 'staff', 'admin'] } },
              status: 'active' as const,
              ...areaFilter,
            }
          : { id: { in: pickedIds }, status: 'active' as const };

    const deepLink = sanitizeNotificationCtaUrl(input.ctaUrl);
    const payload =
      deepLink && input.ctaLabelEn && input.ctaLabelAr
        ? {
            ctaLabelEn: input.ctaLabelEn.trim(),
            ctaLabelAr: input.ctaLabelAr.trim(),
            ctaUrl: deepLink,
          }
        : undefined;

    const users = await this.prisma.user.findMany({
      where,
      select: { id: true },
    });
    if (input.audience === 'individual' && !users.length) {
      throw new BadRequestException(
        'None of the selected accounts could receive this notification',
      );
    }
    const recipientIds: string[] = [];
    for (const { id: userId } of users) {
      const created = await this.create({
        userId,
        category: 'system',
        titleEn: input.titleEn,
        titleAr: input.titleAr,
        bodyEn: input.bodyEn,
        bodyAr: input.bodyAr,
        deepLink,
        payload,
      });
      if (created) recipientIds.push(userId);
    }
    return { sent: recipientIds.length, recipientIds };
  }
}
