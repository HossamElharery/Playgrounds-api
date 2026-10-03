import { moneyText } from '../../common/money/money-text';
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

  /**
   * An owner with more than one venue gets "Marina Hub: …" so a reminder is never ambiguous.
   * Only the venue's owner is tagged (a player's booking notice is not), and a title that
   * already names the venue is left alone. Best effort: a failure here never blocks the notice.
   */
  private async tagWithVenue(input: CreateNotificationInput): Promise<CreateNotificationInput> {
    const venueId = input.payload?.['venueId'];
    if (typeof venueId !== 'string') return input;
    try {
      const venue = await this.prisma.venue.findUnique({
        where: { id: venueId },
        select: { ownerId: true, nameAr: true, nameEn: true },
      });
      if (!venue || venue.ownerId !== input.userId) return input;
      const venues = await this.prisma.venue.count({ where: { ownerId: venue.ownerId } });
      if (venues < 2) return input;
      const tag = (title: string, name: string) =>
        !name || title.includes(name) ? title : `${name}: ${title}`;
      return {
        ...input,
        titleAr: tag(input.titleAr, venue.nameAr),
        titleEn: tag(input.titleEn, venue.nameEn),
      };
    } catch {
      return input;
    }
  }

  async create(raw: CreateNotificationInput) {
    const input = await this.tagWithVenue(raw);
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

  async list(userId: string, cursor?: string, limit = 30) {
    const page = await paginateByCursor(
      (args) =>
        this.prisma.notification.findMany({
          where: { userId },
          orderBy: { id: 'desc' },
          ...args,
        }),
      limit,
      cursor,
    );
    // Old cash notices embedded minor units in the title. Correct only identified
    // cash records, using their immutable amount/currency; never guess from prose.
    const payloads = page.items.map(n => n.payload as Record<string, unknown> | null);
    const ids = (key: string) => payloads.flatMap(p => typeof p?.[key] === 'string' ? [p[key] as string] : []);
    const shiftIds = ids('shiftId');
    const handoverIds = ids('handoverId');
    if (!shiftIds.length && !handoverIds.length) return page;
    const select = { id: true, venueId: true, difference: true, currency: true } as const;
    const [shifts, handovers] = await Promise.all([
      shiftIds.length ? this.prisma.cashShift.findMany({ where: { id: { in: shiftIds } }, select }) : [],
      handoverIds.length ? this.prisma.cashHandover.findMany({ where: { id: { in: handoverIds } }, select }) : [],
    ]);
    type CashNoticeSource = { id: string; venueId: string; difference: number; currency: string };
    const shiftMap = new Map<string, CashNoticeSource>((shifts as CashNoticeSource[]).map(s => [s.id, s]));
    const handoverMap = new Map<string, CashNoticeSource>((handovers as CashNoticeSource[]).map(h => [h.id, h]));
    return { ...page, items: page.items.map(n => {
      const p = n.payload as Record<string, unknown> | null;
      const cash = typeof p?.['shiftId'] === 'string' ? shiftMap.get(p['shiftId'])
        : typeof p?.['handoverId'] === 'string' ? handoverMap.get(p['handoverId']) : undefined;
      if (!cash || cash.venueId !== p?.['venueId']) return n;
      const amount = Math.abs(cash.difference);
      const fix = (title: string, lang: 'ar' | 'en') => title.replace(/(?<![\d.,])(\d+) (EGP|AED|SAR|KWD|QAR|JOD)\b/g,
        (match, raw: string) => Number(raw) === amount ? moneyText(amount, cash.currency, lang) : match);
      return { ...n, titleAr: fix(n.titleAr, 'ar'), titleEn: fix(n.titleEn, 'en') };
    }) };
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
