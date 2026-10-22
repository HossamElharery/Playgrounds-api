import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { User } from '@prisma/client';
import { ApiException } from '../../common/errors/api-exception';
import { guestDisplayName } from '../auth/guest-name.util';
import { PrismaService } from '../prisma/prisma.service';
import { TurnstileService } from '../ai/turnstile.service';
import { camoEnabled } from './camo-flags';
import { CamoSettingsService } from './camo-settings.service';

const DAY_MS = 24 * 60 * 60 * 1000;
export const CAMO_GUEST_RETENTION_MS = 30 * DAY_MS;

/** Instant guests of the camo game (`POST /auth/guest/play`) and their daily cleanup (section 4.1c). */
@Injectable()
export class CamoGuestService {
  private readonly logger = new Logger(CamoGuestService.name);
  private readonly byIp = new Map<string, number[]>();
  private readonly byDevice = new Map<string, number[]>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly turnstile: TurnstileService,
    private readonly settings: CamoSettingsService,
  ) {}

  private bump(map: Map<string, number[]>, key: string, limit: number, now: number): boolean {
    const list = (map.get(key) ?? []).filter((t) => now - t < DAY_MS);
    if (list.length >= limit) {
      map.set(key, list);
      return false;
    }
    list.push(now);
    if (map.size > 20_000) map.clear();
    map.set(key, list);
    return true;
  }

  /** Creates the guest row; the caller issues the token pair. */
  async create(input: { name?: string; lang?: 'ar' | 'en'; turnstileToken?: string; deviceId?: string; ip?: string }, now = Date.now()): Promise<User> {
    if (!camoEnabled(this.config)) throw new ApiException(HttpStatus.NOT_FOUND, 'CAMO_DISABLED', 'The game is not available');
    if (this.turnstile.enabled) {
      const verdict = await this.turnstile.verify(input.turnstileToken ?? '', input.ip);
      if (verdict === 'failed') throw new ApiException(HttpStatus.FORBIDDEN, 'CHALLENGE_FAILED', 'Challenge failed');
    }
    const s = await this.settings.load();
    if (input.ip && !this.bump(this.byIp, input.ip, s.guestPerIpPerDay, now)) {
      throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, 'GUEST_LIMIT_IP', 'Too many guests from this network today');
    }
    if (input.deviceId && !this.bump(this.byDevice, input.deviceId, s.guestPerDevicePerDay, now)) {
      throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, 'GUEST_LIMIT_DEVICE', 'Too many guests from this device today');
    }
    const lang = input.lang === 'en' ? 'en' : 'ar';
    return this.prisma.user.create({
      data: { name: guestDisplayName(input.name, lang), isGuest: true, guestSource: 'camo_play', roles: ['player'], preferredLang: lang },
    });
  }

  /**
   * Daily: removes only `camo_play` guests that never converted, have not been seen for 30 days and own no bookings or
   * payments. Match records stay (CamoMatchPlayer.userId is set to null by the foreign key); squad-link guests are the
   * business of `SquadService.sweepGuests`, never of this job.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweep(now = Date.now()): Promise<number> {
    const cutoff = new Date(now - CAMO_GUEST_RETENTION_MS);
    const where = {
      isGuest: true,
      guestSource: 'camo_play',
      createdAt: { lt: cutoff },
      OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }],
      bookings: { none: {} },
      squadMemberships: { none: {} },
    };
    const stale = await this.prisma.user.findMany({ where, select: { id: true }, take: 500 });
    let removed = 0;
    for (const g of stale) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const current = await tx.user.findFirst({ where: { ...where, id: g.id }, select: { id: true } });
          if (!current) return;
          await tx.friendship.deleteMany({ where: { OR: [{ requesterId: g.id }, { addresseeId: g.id }] } });
          await tx.user.delete({ where: { id: g.id, isGuest: true } });
          removed++;
        });
      } catch (err) {
        this.logger.warn(`guest ${g.id} not swept: ${err instanceof Error ? err.message : err}`);
      }
    }
    return removed;
  }
}
