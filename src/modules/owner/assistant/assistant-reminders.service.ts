import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { withJobLock } from '../../../common/utils/job-lock.util';
import { findOwed, type OwedRow } from './assistant-attention';
import { fmtMoney } from './assistant-money';
import { zonedHhmm } from '../../../common/utils/timezone.util';

const HOUR = 3_600_000;
/** The two moments of the day (venue-local) the overdue digest is sent. */
const OVERDUE_LOCAL_HOURS = [11, 20] as const;

/** 0–23 on the venue's own clock. */
export function localHour(now: Date, timeZone: string): number {
  return Number(zonedHhmm(now, timeZone).slice(0, 2));
}
/** The same unpaid set is mentioned again only after this long; a changed set is sent at once. */
const SAME_DEBT_REMINDER_MS = 72 * HOUR;

/** Identifies exactly which bookings owe exactly how much, so an unchanged debt is not announced twice. */
export function debtFingerprint(list: Pick<OwedRow, 'id' | 'outstanding'>[]): string {
  const parts = list.map((b) => `${b.id}:${b.outstanding}`).sort();
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * The assistant's proactive side: it pushes the two reminders an owner would
 * otherwise forget — cash still owed on played bookings, and a customer about
 * to arrive with a balance. Each reminder is sent once (deduped on the
 * notification's own payload), so a slow owner is nudged, not nagged.
 */
@Injectable()
export class AssistantRemindersService {
  private readonly logger = new Logger(AssistantRemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Late morning and evening — on EACH VENUE'S OWN clock: what is still owed from bookings already played.
   * It wakes every hour and sends only to venues for which it is now 11:00 or 20:00 locally, so a Dubai
   * owner is nudged at their lunchtime, not at 12:00 Cairo time.
   */
  @Cron('0 * * * *')
  async overdueDigest(): Promise<void> {
    try {
      await withJobLock(this.prisma, 'assistant.overdue', async () => {
        await this.sendOverdue(new Date(), { localHours: OVERDUE_LOCAL_HOURS });
      });
    } catch (err) {
      this.logger.error(`Overdue reminders failed: ${String(err)}`);
    }
  }

  /** Every 15 minutes: bookings starting in 30–75 minutes that still owe money. */
  @Cron('*/15 * * * *')
  async arrivalReminders(): Promise<void> {
    try {
      await withJobLock(this.prisma, 'assistant.arrivals', async () => {
        await this.sendArrivals();
      });
    } catch (err) {
      this.logger.error(`Arrival reminders failed: ${String(err)}`);
    }
  }

  async sendOverdue(now = new Date(), opts: { localHours?: readonly number[] } = {}): Promise<number> {
    const rows = await findOwed(this.prisma, {}, { kind: 'overdue', now });
    let sent = 0;
    for (const [venueId, list] of groupByVenue(rows)) {
      const venue = await this.prisma.venue.findUnique({
        where: { id: venueId },
        select: { ownerId: true, nameAr: true, nameEn: true, country: { select: { timezone: true } } },
      });
      if (!venue) continue;
      if (opts.localHours && !opts.localHours.includes(localHour(now, venue.country?.timezone ?? 'Africa/Cairo'))) continue;
      // Once per venue per half-day: the digest is a nudge, not a feed.
      if (await this.recently(venue.ownerId, 'assistant_overdue', 'venueId', venueId, 10 * HOUR, now))
        continue;
      // …and the same unpaid bookings are not announced again the next morning: only a change
      // (a new debt, a part-payment) or three quiet days brings the digest back.
      const fingerprint = debtFingerprint(list);
      if (await this.recently(venue.ownerId, 'assistant_overdue', 'fingerprint', fingerprint, SAME_DEBT_REMINDER_MS, now))
        continue;
      const total = list.reduce((sum, b) => sum + b.outstanding, 0);
      const names = list
        .slice(0, 3)
        .map((b) => b.customerName ?? b.code)
        .join('، ');
      const cur = list[0].currency;
      await this.notifications
        .create({
          userId: venue.ownerId,
          category: 'bookings',
          titleAr: `فلوس لسه عند العملاء: ${fmtMoney(total, cur).ar}`,
          titleEn: `Still owed to you: ${fmtMoney(total, cur).en}`,
          bodyAr: `${list.length} حجز خلص ولسه عليهم فلوس (${names}${list.length > 3 ? '…' : ''}) — ${venue.nameAr}. افتح المساعد واكتب «فلان دفع» أول ما تحصّل.`,
          bodyEn: `${list.length} finished bookings still owe money (${names}${list.length > 3 ? '…' : ''}) — ${venue.nameEn}.`,
          // Opens THIS venue's Today screen, where the unpaid list lives — not whichever venue was last open.
          deepLink: `/owner/today?venue=${venueId}`,
          payload: { kind: 'assistant_overdue', venueId, count: list.length, total, fingerprint },
        })
        .then(() => sent++)
        .catch((err) => this.logger.warn(`overdue reminder failed: ${String(err)}`));
    }
    return sent;
  }

  async sendArrivals(now = new Date()): Promise<number> {
    const rows = await findOwed(
      this.prisma,
      {},
      {
        kind: 'upcoming',
        from: new Date(now.getTime() + 30 * 60_000),
        to: new Date(now.getTime() + 75 * 60_000),
      },
    );
    let sent = 0;
    for (const b of rows) {
      const venue = await this.prisma.venue.findUnique({
        where: { id: b.venueId },
        select: { ownerId: true, country: { select: { timezone: true } } },
      });
      if (!venue) continue;
      if (await this.recently(venue.ownerId, 'assistant_arrival_due', 'bookingId', b.id, 24 * HOUR, now))
        continue;
      const tz = venue.country?.timezone ?? 'Africa/Cairo';
      const who = b.customerName ?? b.code;
      await this.notifications
        .create({
          userId: venue.ownerId,
          category: 'bookings',
          titleAr: `${who} جاي ${zonedHhmm(b.slotStart, tz)} وعليه ${fmtMoney(b.outstanding, b.currency).ar}`,
          titleEn: `${who} arrives ${zonedHhmm(b.slotStart, tz)} owing ${fmtMoney(b.outstanding, b.currency).en}`,
          bodyAr: `${b.courtName} — حصّل الباقي وهو داخل.`,
          bodyEn: `${b.courtName} — collect the balance at the door.`,
          // Straight to the booking that owes, in the right venue.
          deepLink: `/owner/today?venue=${b.venueId}&booking=${b.id}`,
          payload: { kind: 'assistant_arrival_due', venueId: b.venueId, bookingId: b.id },
        })
        .then(() => sent++)
        .catch((err) => this.logger.warn(`arrival reminder failed: ${String(err)}`));
    }
    return sent;
  }

  private async recently(
    userId: string,
    kind: string,
    key: 'venueId' | 'bookingId' | 'fingerprint',
    value: string,
    withinMs: number,
    now: Date,
  ): Promise<boolean> {
    const hit = await this.prisma.notification.findFirst({
      where: {
        userId,
        createdAt: { gte: new Date(now.getTime() - withinMs) },
        AND: [
          { payload: { path: ['kind'], equals: kind } },
          { payload: { path: [key], equals: value } },
        ],
      },
      select: { id: true },
    });
    return !!hit;
  }
}

function groupByVenue(rows: OwedRow[]): Map<string, OwedRow[]> {
  const map = new Map<string, OwedRow[]>();
  for (const r of rows) map.set(r.venueId, [...(map.get(r.venueId) ?? []), r]);
  return map;
}
