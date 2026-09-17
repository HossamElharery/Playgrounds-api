import { Prisma } from '@prisma/client';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { paginateByCursor } from '../../common/pagination/cursor-pagination.dto';
import { UpdateNotificationPrefsDto } from './dto/device-token.dto';
import { sanitizeNotificationCtaUrl } from './cta-url';

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
      select: { notificationPrefs: true },
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
    void this.dispatchPush(input.userId, notification.titleEn, notification.bodyEn);
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
    const pickedIds = [...new Set((input.recipientIds ?? []).map((id) => id.trim()).filter(Boolean))];
    if (input.audience === 'individual' && !pickedIds.length) {
      throw new BadRequestException('Select at least one recipient');
    }
    const where: Prisma.UserWhereInput =
      input.audience === 'owners'
        ? { roles: { has: 'owner' as const }, status: 'active' as const, ...areaFilter }
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
      throw new BadRequestException('None of the selected accounts could receive this notification');
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

  private async dispatchPush(
    userId: string,
    title: string,
    body?: string | null,
  ) {
    const serverKey = this.config.get<string>('FCM_SERVER_KEY');
    if (!serverKey) return;
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });
    if (!tokens.length) return;
    try {
      await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `key=${serverKey}`,
        },
        body: JSON.stringify({
          registration_ids: tokens.map((t) => t.token),
          notification: { title, body: body ?? title },
          content_available: true,
        }),
      });
    } catch (err) {
      this.logger.warn(`FCM dispatch failed: ${err}`);
    }
  }
}
