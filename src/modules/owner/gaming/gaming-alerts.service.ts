import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { withJobLock } from '../../../common/utils/job-lock.util';

export const GAMING_ALERT_THRESHOLDS = {
  printFailuresOwner: 3,
  printFailuresAdmin: 10,
  lowStock: 3,
  stuckEventAttempts: 5,
  windowMinutes: 60,
} as const;

@Injectable()
export class GamingAlertsService {
  private readonly logger = new Logger(GamingAlertsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0 */10 * * * *')
  async sweep() {
    await withJobLock(this.prisma, 'gaming-alerts', async () => {
      await this.printFailures().catch((e) => this.logger.warn(`print alert sweep failed: ${e?.message ?? e}`));
      await this.lowStock().catch((e) => this.logger.warn(`stock alert sweep failed: ${e?.message ?? e}`));
      await this.financialMismatch().catch((e) => this.logger.warn(`reconciliation sweep failed: ${e?.message ?? e}`));
      await this.threatenedBookings().catch((e) => this.logger.warn(`booking sweep failed: ${e?.message ?? e}`));
      await this.stuckEvents().catch((e) => this.logger.warn(`event sweep failed: ${e?.message ?? e}`));
    });
  }

  private bucket(minutes: number = GAMING_ALERT_THRESHOLDS.windowMinutes) {
    return Math.floor(Date.now() / (minutes * 60_000));
  }

  private async admins() {
    return (
      await this.prisma.user.findMany({ where: { roles: { has: 'admin' }, status: 'active' }, select: { id: true } })
    ).map((a) => a.id);
  }

  private async venueOwner(venueId: string) {
    return this.prisma.venue.findUnique({ where: { id: venueId }, select: { ownerId: true, nameAr: true, nameEn: true } });
  }

  async printFailures() {
    const since = new Date(Date.now() - GAMING_ALERT_THRESHOLDS.windowMinutes * 60_000);
    const rows = await this.prisma.gamingPrintJob.groupBy({
      by: ['receiptId'],
      where: { status: 'failed', updatedAt: { gte: since } },
      _count: { _all: true },
    });
    if (!rows.length) return;
    const receipts = await this.prisma.receiptDocument.findMany({
      where: { id: { in: rows.map((r) => r.receiptId) } },
      select: { id: true, venueId: true },
    });
    const venueOf = new Map(receipts.map((r) => [r.id, r.venueId]));
    const perVenue = new Map<string, number>();
    for (const row of rows) {
      const venueId = venueOf.get(row.receiptId);
      if (venueId) perVenue.set(venueId, (perVenue.get(venueId) ?? 0) + row._count._all);
    }
    for (const [venueId, count] of perVenue) {
      if (count < GAMING_ALERT_THRESHOLDS.printFailuresOwner) continue;
      const venue = await this.venueOwner(venueId);
      if (!venue) continue;
      const key = `${venueId}:${this.bucket()}`;
      await this.notifications
        .create({
          dedupKey: `gaming-print:${key}:${venue.ownerId}`,
          userId: venue.ownerId,
          category: 'system',
          titleAr: `${venue.nameAr}: تعذّرت الطباعة أكثر من مرة`,
          titleEn: `${venue.nameEn}: printing keeps failing`,
          bodyAr: 'تم التحصيل بنجاح. تحقق من الطابعة ثم أعد الطباعة من الإيصال المحفوظ.',
          bodyEn: 'Payments were recorded. Check the printer, then reprint from the saved receipt.',
          deepLink: '/owner/gaming',
          payload: { kind: 'gaming_print_failures', venueId, count },
        })
        .catch(() => undefined);
      if (count >= GAMING_ALERT_THRESHOLDS.printFailuresAdmin) {
        for (const adminId of await this.admins()) {
          await this.notifications
            .create({
              dedupKey: `gaming-print-admin:${key}:${adminId}`,
              userId: adminId,
              category: 'system',
              titleAr: `نمط فشل طباعة متكرر: ${venue.nameAr}`,
              titleEn: `Repeated print failures: ${venue.nameEn}`,
              bodyAr: `${count} محاولة طباعة فاشلة خلال الساعة الأخيرة.`,
              bodyEn: `${count} failed print jobs in the last hour.`,
              deepLink: '/admin/venues',
              payload: { kind: 'gaming_print_failures', venueId, count },
            })
            .catch(() => undefined);
        }
      }
    }
  }

  async lowStock() {
    const day = new Date().toISOString().slice(0, 10);
    const products = await this.prisma.gamingProduct.findMany({
      where: { stockTracked: true, active: true, availableQuantity: { lte: GAMING_ALERT_THRESHOLDS.lowStock } },
      select: { id: true, venueId: true, nameAr: true, nameEn: true, availableQuantity: true },
      take: 200,
    });
    const byVenue = new Map<string, typeof products>();
    for (const p of products) byVenue.set(p.venueId, [...(byVenue.get(p.venueId) ?? []), p]);
    for (const [venueId, list] of byVenue) {
      const venue = await this.venueOwner(venueId);
      if (!venue) continue;
      const names = (key: 'nameAr' | 'nameEn') => list.slice(0, 3).map((p) => p[key]).join('، ');
      await this.notifications
        .create({
          dedupKey: `gaming-stock:${venueId}:${day}:${venue.ownerId}`,
          userId: venue.ownerId,
          category: 'system',
          titleAr: `${venue.nameAr}: مخزون منخفض`,
          titleEn: `${venue.nameEn}: low stock`,
          bodyAr: `${list.length} منتج على وشك النفاد: ${names('nameAr')}`,
          bodyEn: `${list.length} product(s) running out: ${names('nameEn').replace(/، /g, ', ')}`,
          deepLink: '/owner/gaming',
          payload: { kind: 'gaming_low_stock', venueId, count: list.length },
        })
        .catch(() => undefined);
    }
  }

  async financialMismatch() {
    const rows = await this.prisma.$queryRaw<{ venueId: string; payments: bigint }[]>(Prisma.sql`
      SELECT o."venueId" AS "venueId", COUNT(*)::bigint AS payments
      FROM "Payment" p
      JOIN "GamingOrder" o ON o.id = p."gamingOrderId"
      WHERE p.status IN ('paid','refunded')
        AND p."createdAt" > now() - interval '24 hours'
        AND COALESCE((SELECT SUM(a."amountMinor") FROM "GamingPaymentAllocation" a WHERE a."paymentId" = p.id), 0)::bigint * p."moneyScale"
            <> p.amount::bigint * o."moneyScale"
      GROUP BY o."venueId"`);
    if (!rows.length) return;
    const admins = await this.admins();
    for (const row of rows) {
      const venue = await this.venueOwner(row.venueId);
      if (!venue) continue;
      const count = Number(row.payments);
      const key = `${row.venueId}:${this.bucket(360)}`;
      for (const userId of new Set([venue.ownerId, ...admins])) {
        await this.notifications
          .create({
            dedupKey: `gaming-mismatch:${key}:${userId}`,
            userId,
            category: 'system',
            titleAr: `${venue.nameAr}: عدم تطابق في مدفوعات الحسابات`,
            titleEn: `${venue.nameEn}: bill payment totals do not match`,
            bodyAr: `${count} دفعة لا يطابق مجموع توزيعها قيمتها. لا تُجرِ تعديلات مالية يدوية وراجع الدعم.`,
            bodyEn: `${count} payment(s) differ from their allocation total. Do not adjust manually; contact support.`,
            deepLink: userId === venue.ownerId ? '/owner/earnings' : '/admin/venues',
            payload: { kind: 'gaming_reconciliation', venueId: row.venueId, count },
          })
          .catch(() => undefined);
      }
    }
  }

  async threatenedBookings() {
    const now = new Date();
    const horizon = new Date(now.getTime() + 10 * 60_000);
    const sessions = await this.prisma.usageSession.findMany({
      where: { state: 'running' },
      select: { id: true, unitId: true, venueId: true, bookingId: true, expectedEnd: true },
      take: 300,
    });
    for (const s of sessions) {
      const next = await this.prisma.booking.findFirst({
        where: {
          courtId: s.unitId,
          status: 'confirmed',
          slotStart: { gt: now, lte: horizon },
          ...(s.bookingId ? { id: { not: s.bookingId } } : {}),
        },
        orderBy: { slotStart: 'asc' },
        select: { id: true, slotStart: true },
      });
      if (!next || (s.expectedEnd && s.expectedEnd > now && s.expectedEnd <= next.slotStart)) continue;
      const venue = await this.prisma.venue.findUnique({
        where: { id: s.venueId },
        select: { ownerId: true, nameAr: true, nameEn: true },
      });
      const unit = await this.prisma.court.findUnique({ where: { id: s.unitId }, select: { name: true } });
      if (!venue || !unit) continue;
      const staff = await this.prisma.staffMember.findMany({
        where: {
          user: { roles: { has: 'staff' }, status: 'active' },
          ownerId: venue.ownerId,
          venueIds: { has: s.venueId },
          permissions: { has: 'sessions.transfer' },
        },
        select: { userId: true },
      });
      for (const userId of new Set([venue.ownerId, ...staff.map((x) => x.userId)])) {
        await this.notifications
          .create({
            dedupKey: `gaming-next-booking:${s.id}:${next.id}:${userId}`,
            userId,
            category: 'system',
            titleAr: `${venue.nameAr}: حجز قادم يتعارض مع جلسة جارية`,
            titleEn: `${venue.nameEn}: upcoming booking overlaps a running session`,
            bodyAr: `${unit.name} عليه حجز يبدأ قريبًا. انقل الجلسة أو أنهِها.`,
            bodyEn: `${unit.name} has a booking starting soon. Transfer or end the session.`,
            deepLink: '/owner/gaming',
            payload: { venueId: s.venueId, sessionId: s.id, bookingId: next.id },
          })
          .catch(() => undefined);
      }
    }
  }

  async stuckEvents() {
    const stuck = await this.prisma.gamingOutbox.count({
      where: { deliveredAt: null, attempts: { gte: GAMING_ALERT_THRESHOLDS.stuckEventAttempts } },
    });
    if (!stuck) return;
    for (const adminId of await this.admins()) {
      await this.notifications
        .create({
          dedupKey: `gaming-outbox:${this.bucket(360)}:${adminId}`,
          userId: adminId,
          category: 'system',
          titleAr: 'أحداث تشغيل لا تصل',
          titleEn: 'Gaming events are failing to deliver',
          bodyAr: `${stuck} حدثًا فشل تسليمه أكثر من ${GAMING_ALERT_THRESHOLDS.stuckEventAttempts} مرات.`,
          bodyEn: `${stuck} event(s) failed delivery more than ${GAMING_ALERT_THRESHOLDS.stuckEventAttempts} times.`,
          deepLink: '/admin',
          payload: { kind: 'gaming_outbox_stuck', count: stuck },
        })
        .catch(() => undefined);
    }
  }
}
