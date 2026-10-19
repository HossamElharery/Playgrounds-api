import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { withJobLock } from '../../common/utils/job-lock.util';
import { BookingNotifier, bookingNoticeDedupKey } from './booking-notifier.service';

const LOOKBACK_MS = 30 * 60_000;
const SETTLE_MS = 60_000;

/**
 * Safety net for the owner's "new booking" notice. The notice is sent right after
 * the booking commits; if the process died between the two, or every retry failed,
 * this sweep finds confirmed Matchena bookings without their owner notification and
 * sends it. dedupKey makes it safe to run on every backend instance and every minute.
 */
@Injectable()
export class BookingNoticeReconciler {
  private readonly logger = new Logger(BookingNoticeReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: BookingNotifier,
  ) {}

  @Cron('30 * * * * *')
  async sweep(): Promise<void> {
    try {
      await withJobLock(this.prisma, 'bookingVenueNotices', async () => {
        await this.reconcile();
      });
    } catch (error) {
      this.logger.warn(`bookingVenueNotices skipped: ${error instanceof Error ? error.message : error}`);
    }
  }

  async reconcile(now = new Date()): Promise<number> {
    const bookings = await this.prisma.booking.findMany({
      where: {
        source: 'platform',
        status: 'confirmed',
        updatedAt: { gte: new Date(now.getTime() - LOOKBACK_MS), lte: new Date(now.getTime() - SETTLE_MS) },
      },
      select: { id: true, venue: { select: { ownerId: true } } },
      take: 200,
    });
    if (!bookings.length) return 0;
    const keyOf = (b: (typeof bookings)[number]) =>
      bookingNoticeDedupKey('booking_confirmed', b.id, b.venue.ownerId);
    const have = new Set(
      (
        await this.prisma.notification.findMany({
          where: { dedupKey: { in: bookings.map(keyOf) } },
          select: { dedupKey: true },
        })
      ).map((n) => n.dedupKey),
    );
    const missing = bookings.filter((b) => !have.has(keyOf(b)));
    for (const b of missing) await this.notifier.notifyVenueSide(b.id, 'booking_confirmed');
    if (missing.length) this.logger.warn(`Re-sent ${missing.length} missing owner booking notice(s)`);
    return missing.length;
  }
}
