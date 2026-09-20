import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  DEFAULT_COMMISSION_BPS,
  MAX_COMMISSION_BPS,
  MIN_COMMISSION_BPS,
} from '../../common/money/booking-money';

export type DbClient = Prisma.TransactionClient | PrismaService;

@Injectable()
export class CommissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async resolveBps(venueId: string, tx?: DbClient): Promise<number> {
    const db = tx ?? this.prisma;
    const venueRow = await db.commissionSetting.findUnique({
      where: { venueId },
    });
    if (venueRow) return venueRow.percentageBps;
    const global = await db.commissionSetting.findFirst({
      where: { venueId: null },
    });
    return global?.percentageBps ?? DEFAULT_COMMISSION_BPS;
  }

  async resolveSource(
    venueId: string,
    tx?: DbClient,
  ): Promise<{ bps: number; source: 'venue' | 'global' }> {
    const db = tx ?? this.prisma;
    const venueRow = await db.commissionSetting.findUnique({
      where: { venueId },
    });
    if (venueRow) return { bps: venueRow.percentageBps, source: 'venue' };
    const global = await db.commissionSetting.findFirst({
      where: { venueId: null },
    });
    return {
      bps: global?.percentageBps ?? DEFAULT_COMMISSION_BPS,
      source: 'global',
    };
  }

  async globalBps(tx?: DbClient): Promise<number> {
    const db = tx ?? this.prisma;
    const global = await db.commissionSetting.findFirst({
      where: { venueId: null },
    });
    return global?.percentageBps ?? DEFAULT_COMMISSION_BPS;
  }

  async setVenueBps(
    venueId: string,
    bps: number | null,
    adminId: string,
    reason: string,
  ) {
    if (bps !== null) this.assertBps(bps);
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, ownerId: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.commissionSetting.findUnique({
        where: { venueId },
      });
      const from = existing?.percentageBps ?? (await this.globalBps(tx));
      if (bps === null) {
        if (existing) {
          await tx.commissionSetting.delete({ where: { venueId } });
        }
      } else {
        await tx.commissionSetting.upsert({
          where: { venueId },
          create: { venueId, percentageBps: bps },
          update: { percentageBps: bps },
        });
      }
      const effective = await this.resolveBps(venueId, tx);
      await tx.auditLogEntry.create({
        data: {
          actorUserId: adminId,
          action: 'venue.commission.updated',
          targetType: 'venue',
          targetId: venueId,
          metadata: { venueId, from, to: bps, effective, reason },
        },
      });
      return { from, to: bps, effective, appliesTo: 'new_bookings_only' as const };
    });
  }

  async setGlobalBps(bps: number, adminId: string, reason: string) {
    this.assertBps(bps);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.commissionSetting.findFirst({
        where: { venueId: null },
      });
      const from = existing?.percentageBps ?? DEFAULT_COMMISSION_BPS;
      if (existing) {
        await tx.commissionSetting.update({
          where: { id: existing.id },
          data: { percentageBps: bps },
        });
      } else {
        await tx.commissionSetting.create({
          data: { venueId: null, percentageBps: bps },
        });
      }
      const affected = await tx.venue.count({
        where: { commissionSetting: null },
      });
      await tx.auditLogEntry.create({
        data: {
          actorUserId: adminId,
          action: 'finance.global_commission.updated',
          targetType: 'commission',
          targetId: existing?.id ?? 'global',
          metadata: { from, to: bps, reason, venuesWithoutOverride: affected },
        },
      });
      return { from, to: bps, venuesWithoutOverride: affected };
    });
  }

  async clearVenueOverride(venueId: string, adminId: string, reason: string) {
    return this.setVenueBps(venueId, null, adminId, reason);
  }

  async notifyOwnerCommissionChanged(
    ownerId: string,
    venueId: string,
    effectiveBps: number,
  ) {
    const pct = (effectiveBps / 100).toFixed(effectiveBps % 100 === 0 ? 0 : 1);
    await this.notifications
      .create({
        userId: ownerId,
        category: 'system',
        titleEn: `Matchena commission is now ${pct}%`,
        titleAr: `عمولة ماتشنا بقت ${pct}٪`,
        bodyEn: `Applies to new Matchena bookings only. Your previous bookings keep their original rate.`,
        bodyAr: `يسري على حجوزات ماتشنا الجديدة فقط. الحجوزات السابقة تفضل بنفس النسبة.`,
        deepLink: '/owner/earnings?section=matchena-account',
        payload: { venueId, commissionBps: effectiveBps },
      })
      .catch(() => undefined);
  }

  private assertBps(bps: number) {
    if (!Number.isInteger(bps) || bps < MIN_COMMISSION_BPS || bps > MAX_COMMISSION_BPS) {
      throw new BadRequestException(
        `percentageBps must be an integer between ${MIN_COMMISSION_BPS} and ${MAX_COMMISSION_BPS}`,
      );
    }
  }
}
