import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { withJobLock } from '../../common/utils/job-lock.util';
import { zonedHhmm } from '../../common/utils/timezone.util';

const LEAD_MS = 60 * 60_000;
/** A booking made less than this long before it starts needs no reminder: the player just made it. */
const MIN_NOTICE_MS = 90 * 60_000;

/** Tells the player their game starts within the hour. One notice per booking (dedupKey). */
@Injectable()
export class BookingReminderService {
  private readonly logger = new Logger(BookingReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0 */5 * * * *')
  async sweep(): Promise<void> {
    try {
      await withJobLock(this.prisma, 'bookingPlayerReminders', async () => {
        await this.remind();
      });
    } catch (error) {
      this.logger.warn(`bookingPlayerReminders skipped: ${error instanceof Error ? error.message : error}`);
    }
  }

  async remind(now = new Date()): Promise<number> {
    const rows = await this.prisma.booking.findMany({
      where: {
        source: 'platform',
        status: 'confirmed',
        slotStart: { gt: now, lte: new Date(now.getTime() + LEAD_MS) },
      },
      include: {
        court: { select: { name: true } },
        venue: { select: { nameEn: true, nameAr: true, country: { select: { timezone: true } } } },
      },
      take: 200,
    });
    let sent = 0;
    for (const b of rows) {
      if (b.slotStart.getTime() - b.createdAt.getTime() < MIN_NOTICE_MS) continue;
      const time = zonedHhmm(b.slotStart, b.venue.country.timezone);
      try {
        await this.notifications.create({
          dedupKey: `booking-reminder-player:${b.id}`,
          userId: b.userId,
          category: 'bookings',
          titleEn: `Your game starts at ${time}`,
          titleAr: `مباراتك الساعة ${time}`,
          bodyEn: `${b.venue.nameEn} — ${b.court.name} · ${b.code}`,
          bodyAr: `${b.venue.nameAr} — ${b.court.name} · ${b.code}`,
          deepLink: '/app/bookings',
          payload: { kind: 'booking_reminder', bookingId: b.id, venueId: b.venueId },
        });
        sent += 1;
      } catch (error) {
        this.logger.warn(`Reminder for booking ${b.id} failed: ${String(error)}`);
      }
    }
    return sent;
  }
}
