import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, VenueSubscription } from '@prisma/client';
import { ApiException } from '../../common/errors/api-exception';
import { assertVenueAccess } from '../../common/access/owner-access';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { NotificationsService } from '../notifications/notifications.service';
import { withJobLock } from '../../common/utils/job-lock.util';
import { PrismaService } from '../prisma/prisma.service';
import { ExtendSubscriptionDto, UpdateSubscriptionTermsDto } from './dto/subscription.dto';
import {
  DAY_MS,
  EXPIRING_SOON_DAYS,
  extendedPeriodEnd,
  subscriptionStanding,
  type SubscriptionState,
} from './subscription-state.util';

export const DEFAULT_LIST_PRICE = 300_000; // 3,000 EGP in piasters
export const DEFAULT_TRIAL_DAYS = 30;

/** Local yyyy-mm-dd in a time zone. */
function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function fmtDate(d: Date, timeZone: string, lang: 'en' | 'ar'): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Creates the subscription if a venue somehow has none (seed data, legacy rows). */
  async ensure(
    venueId: string,
    days = DEFAULT_TRIAL_DAYS,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<VenueSubscription> {
    const existing = await db.venueSubscription.findUnique({ where: { venueId } });
    if (existing) return existing;
    return db.venueSubscription.create({
      data: { venueId, currentPeriodEnd: new Date(Date.now() + days * DAY_MS) },
    });
  }

  /** Called from the approval flow with the days the admin typed. */
  async startOrExtendOnApproval(
    tx: Prisma.TransactionClient,
    adminId: string,
    venueId: string,
    days: number,
    agreedPriceAmount?: number,
  ): Promise<void> {
    const existing = await tx.venueSubscription.findUnique({ where: { venueId } });
    if (!existing) {
      const created = await tx.venueSubscription.create({
        data: {
          venueId,
          currentPeriodEnd: new Date(Date.now() + days * DAY_MS),
          agreedPriceAmount: agreedPriceAmount ?? null,
        },
      });
      await tx.auditLogEntry.create({
        data: {
          actorUserId: adminId,
          action: 'subscription.started',
          targetType: 'venue',
          targetId: venueId,
          metadata: { venueId, days, subscriptionId: created.id } as Prisma.InputJsonValue,
        },
      });
      return;
    }
    const end = extendedPeriodEnd(existing.currentPeriodEnd, days);
    await tx.venueSubscription.update({
      where: { venueId },
      data: { currentPeriodEnd: end, ...(agreedPriceAmount != null ? { agreedPriceAmount } : {}) },
    });
    await tx.subscriptionPayment.create({
      data: {
        subscriptionId: existing.id,
        venueId,
        amount: 0,
        daysAdded: days,
        periodEndBefore: existing.currentPeriodEnd,
        periodEndAfter: end,
        note: 'Added on approval',
        recordedById: adminId,
      },
    });
  }

  // ---- owner-facing ------------------------------------------------------

  /** What the owner sees: the plan, the struck-through list price, the dates. Never the agreed price. */
  async forOwner(user: AuthenticatedUser, venueId: string) {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const sub = await this.ensure(venueId);
    const standing = subscriptionStanding(sub);
    return {
      venueId,
      planKey: sub.planKey,
      listPriceAmount: sub.listPriceAmount,
      currency: sub.currency,
      isFree: true,
      currentPeriodEnd: sub.currentPeriodEnd,
      graceDays: sub.graceDays,
      graceEndsAt: standing.graceEndsAt,
      state: standing.state,
      daysLeft: standing.daysLeft,
      graceDaysLeft: standing.graceDaysLeft,
    };
  }

  // ---- admin -------------------------------------------------------------

  async forAdmin(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, nameEn: true, nameAr: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    const sub = await this.ensure(venueId);
    const payments = await this.prisma.subscriptionPayment.findMany({
      where: { venueId },
      orderBy: { paidAt: 'desc' },
      take: 50,
      include: { recordedBy: { select: { name: true } } },
    });
    return {
      ...this.adminDto(sub, venue),
      payments: payments.map((p) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        method: p.method,
        daysAdded: p.daysAdded,
        periodEndBefore: p.periodEndBefore,
        periodEndAfter: p.periodEndAfter,
        paidAt: p.paidAt,
        note: p.note,
        recordedBy: p.recordedBy.name,
      })),
    };
  }

  async updateTerms(admin: AuthenticatedUser, venueId: string, dto: UpdateSubscriptionTermsDto) {
    const sub = await this.ensure(venueId);
    const data: Prisma.VenueSubscriptionUpdateInput = {};
    const changed: string[] = [];
    if (dto.listPriceAmount !== undefined) (data.listPriceAmount = dto.listPriceAmount), changed.push('listPrice');
    if (dto.agreedPriceAmount !== undefined) (data.agreedPriceAmount = dto.agreedPriceAmount), changed.push('agreedPrice');
    if (dto.graceDays !== undefined) (data.graceDays = dto.graceDays), changed.push('graceDays');
    if (dto.notes !== undefined) (data.notes = dto.notes), changed.push('notes');
    if (dto.currentPeriodEnd !== undefined) {
      data.currentPeriodEnd = new Date(dto.currentPeriodEnd);
      // Fixing the date by hand starts a fresh reminder cycle.
      data.lastNoticeDate = null;
      changed.push('currentPeriodEnd');
    }
    if (!changed.length) return this.forAdmin(venueId);
    await this.prisma.$transaction([
      this.prisma.venueSubscription.update({ where: { id: sub.id }, data }),
      this.prisma.auditLogEntry.create({
        data: {
          actorUserId: admin.id,
          action: 'subscription.terms_updated',
          targetType: 'venue',
          targetId: venueId,
          metadata: { venueId, changed } as Prisma.InputJsonValue,
        },
      }),
    ]);
    return this.forAdmin(venueId);
  }

  /** "I took the money — add the days." */
  async extend(admin: AuthenticatedUser, venueId: string, dto: ExtendSubscriptionDto) {
    const sub = await this.ensure(venueId);
    const end = extendedPeriodEnd(sub.currentPeriodEnd, dto.days);
    const venue = await this.prisma.venue.findUniqueOrThrow({
      where: { id: venueId },
      select: { ownerId: true, nameEn: true, nameAr: true, country: { select: { timezone: true } } },
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.venueSubscription.update({
        where: { id: sub.id },
        data: { currentPeriodEnd: end, lastNoticeDate: null },
      });
      await tx.subscriptionPayment.create({
        data: {
          subscriptionId: sub.id,
          venueId,
          amount: dto.amount ?? 0,
          currency: sub.currency,
          method: dto.method ?? null,
          daysAdded: dto.days,
          periodEndBefore: sub.currentPeriodEnd,
          periodEndAfter: end,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
          note: dto.note ?? null,
          recordedById: admin.id,
        },
      });
      await tx.auditLogEntry.create({
        data: {
          actorUserId: admin.id,
          action: 'subscription.extended',
          targetType: 'venue',
          targetId: venueId,
          metadata: {
            venueId,
            days: dto.days,
            amount: dto.amount ?? 0,
            from: sub.currentPeriodEnd.toISOString(),
            to: end.toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
    });
    const tz = venue.country?.timezone ?? 'Africa/Cairo';
    await this.notifications
      .create({
        userId: venue.ownerId,
        category: 'system',
        titleEn: 'Your plan was renewed',
        titleAr: 'تم تجديد اشتراكك',
        bodyEn: `${venue.nameEn} is covered until ${fmtDate(end, tz, 'en')}.`,
        bodyAr: `${venue.nameAr} مشمول لغاية ${fmtDate(end, tz, 'ar')}.`,
        deepLink: '/owner/settings',
        payload: { kind: 'subscription_renewed', venueId },
      })
      .catch(() => undefined);
    return this.forAdmin(venueId);
  }

  /** Renewals list: every venue with its standing, soonest-ending first. */
  async listAdmin(query: { state?: string; q?: string }) {
    const venues = await this.prisma.venue.findMany({
      where: query.q?.trim()
        ? {
            OR: [
              { nameEn: { contains: query.q.trim(), mode: 'insensitive' } },
              { nameAr: { contains: query.q.trim(), mode: 'insensitive' } },
              { owner: { name: { contains: query.q.trim(), mode: 'insensitive' } } },
            ],
          }
        : {},
      select: { id: true, nameEn: true, nameAr: true, owner: { select: { id: true, name: true } } },
    });
    // One query for all rows; only a venue that somehow has none pays for a create.
    const existing = await this.prisma.venueSubscription.findMany({
      where: { venueId: { in: venues.map((v) => v.id) } },
    });
    const byVenue = new Map(existing.map((s) => [s.venueId, s]));
    for (const v of venues) {
      if (!byVenue.has(v.id)) byVenue.set(v.id, await this.ensure(v.id));
    }
    const now = new Date();
    const items = venues
      .map((v) => {
        const sub = byVenue.get(v.id)!;
        return { ...this.adminDto(sub, v, now), ownerName: v.owner.name };
      })
      .sort((a, b) => +new Date(a.currentPeriodEnd) - +new Date(b.currentPeriodEnd));
    const counts = { active: 0, expiring: 0, grace: 0, overdue: 0 } as Record<SubscriptionState, number>;
    for (const it of items) counts[it.state] += 1;
    return {
      counts,
      items: query.state ? items.filter((i) => i.state === query.state) : items,
    };
  }

  // ---- the morning job ---------------------------------------------------

  @Cron('0 9 * * *', { timeZone: 'Africa/Cairo' })
  async morningReminders(): Promise<void> {
    try {
      await withJobLock(this.prisma, 'subscriptions.morning', async () => {
        await this.sendDailyReminders();
      });
    } catch (err) {
      this.logger.error(`Morning subscription reminders failed: ${String(err)}`);
    }
  }

  /**
   * Runs once each morning. Owners hear about it when a plan is about to end (7, 3, 1
   * days and the last day) and EVERY morning while it is past its end date. The admin
   * gets one digest. Nothing is ever blocked.
   */
  async sendDailyReminders(now: Date = new Date()): Promise<{ owners: number; admins: number }> {
    const horizon = new Date(now.getTime() + EXPIRING_SOON_DAYS * DAY_MS);
    const subs = await this.prisma.venueSubscription.findMany({
      where: { currentPeriodEnd: { lte: horizon } },
      include: {
        venue: {
          select: { id: true, ownerId: true, nameEn: true, nameAr: true, country: { select: { timezone: true } } },
        },
      },
    });
    let owners = 0;
    const digest = { expiring: 0, grace: 0, overdue: 0 };
    for (const sub of subs) {
      const standing = subscriptionStanding(sub, now);
      if (standing.state === 'expiring') digest.expiring += 1;
      else if (standing.state === 'grace') digest.grace += 1;
      else if (standing.state === 'overdue') digest.overdue += 1;
      else continue;

      const tz = sub.venue.country?.timezone ?? 'Africa/Cairo';
      const today = localDate(now, tz);
      if (sub.lastNoticeDate === today) continue;

      const notice = this.ownerNotice(sub, standing, tz);
      if (!notice) continue;
      await this.notifications
        .create({
          userId: sub.venue.ownerId,
          category: 'system',
          ...notice,
          deepLink: '/owner/settings',
          payload: { kind: 'subscription_reminder', venueId: sub.venueId, state: standing.state },
        })
        .catch((err) => this.logger.warn(`subscription reminder failed: ${String(err)}`));
      await this.prisma.venueSubscription.update({ where: { id: sub.id }, data: { lastNoticeDate: today } });
      owners += 1;
    }

    let admins = 0;
    const total = digest.expiring + digest.grace + digest.overdue;
    if (total > 0) {
      const day = localDate(now, 'Africa/Cairo');
      const adminUsers = await this.prisma.user.findMany({ where: { roles: { has: 'admin' } }, select: { id: true } });
      for (const admin of adminUsers) {
        const already = await this.prisma.notification.findFirst({
          where: { userId: admin.id, payload: { path: ['digestDate'], equals: day } },
          select: { id: true },
        });
        if (already) continue;
        await this.notifications
          .create({
            userId: admin.id,
            category: 'system',
            titleEn: `Renewals: ${digest.overdue} overdue, ${digest.grace} in grace, ${digest.expiring} ending soon`,
            titleAr: `التجديدات: ${digest.overdue} متأخر، ${digest.grace} في السماح، ${digest.expiring} قربت تنتهي`,
            bodyEn: 'Open the subscriptions list to follow up and add days once paid.',
            bodyAr: 'افتح قايمة الاشتراكات للمتابعة وزوّد الأيام لما تستلم الفلوس.',
            deepLink: '/admin/subscriptions',
            payload: { kind: 'subscription_digest', digestDate: day },
          })
          .catch(() => undefined);
        admins += 1;
      }
    }
    if (owners || admins) this.logger.log(`Subscription reminders: ${owners} owner(s), ${admins} admin digest(s)`);
    return { owners, admins };
  }

  private ownerNotice(
    sub: VenueSubscription & { venue: { nameEn: string; nameAr: string } },
    standing: ReturnType<typeof subscriptionStanding>,
    tz: string,
  ) {
    const endEn = fmtDate(sub.currentPeriodEnd, tz, 'en');
    const endAr = fmtDate(sub.currentPeriodEnd, tz, 'ar');
    if (standing.state === 'expiring') {
      // Not every morning: only when it is worth a nudge.
      if (![7, 3, 1].includes(standing.daysLeft)) return null;
      const n = standing.daysLeft;
      return {
        titleEn: `Your plan ends in ${n} day${n === 1 ? '' : 's'}`,
        titleAr: n === 1 ? 'اشتراكك بينتهي بكرة أو النهارده' : `اشتراكك بينتهي بعد ${n} أيام`,
        bodyEn: `${sub.venue.nameEn}: covered until ${endEn}. Contact Matchena to renew.`,
        bodyAr: `${sub.venue.nameAr}: مشمول لغاية ${endAr}. كلّم ماتشنا للتجديد.`,
      };
    }
    if (standing.state === 'grace') {
      return {
        titleEn: `Your plan ended — ${standing.graceDaysLeft} grace day${standing.graceDaysLeft === 1 ? '' : 's'} left`,
        titleAr: `اشتراكك خلص — فاضل ${standing.graceDaysLeft} يوم سماح`,
        bodyEn: `${sub.venue.nameEn} keeps working meanwhile. Contact Matchena to renew.`,
        bodyAr: `${sub.venue.nameAr} شغال عادي في الوقت ده. كلّم ماتشنا للتجديد.`,
      };
    }
    return {
      titleEn: 'Your plan is overdue',
      titleAr: 'اشتراكك متأخر',
      bodyEn: `${sub.venue.nameEn} ended on ${endEn}. Please contact Matchena to renew.`,
      bodyAr: `${sub.venue.nameAr} خلص في ${endAr}. من فضلك كلّم ماتشنا للتجديد.`,
    };
  }

  private adminDto(
    sub: VenueSubscription,
    venue: { id: string; nameEn: string; nameAr: string },
    now: Date = new Date(),
  ) {
    const standing = subscriptionStanding(sub, now);
    return {
      id: sub.id,
      venueId: venue.id,
      venueNameEn: venue.nameEn,
      venueNameAr: venue.nameAr,
      planKey: sub.planKey,
      listPriceAmount: sub.listPriceAmount,
      agreedPriceAmount: sub.agreedPriceAmount,
      currency: sub.currency,
      startedAt: sub.startedAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      graceDays: sub.graceDays,
      notes: sub.notes,
      state: standing.state,
      daysLeft: standing.daysLeft,
      graceEndsAt: standing.graceEndsAt,
      graceDaysLeft: standing.graceDaysLeft,
    };
  }

  assertDays(days: number): void {
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'SUBSCRIPTION_DAYS_INVALID', 'Days must be a whole number between 1 and 3650');
    }
  }
}
