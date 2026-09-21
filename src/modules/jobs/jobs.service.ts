import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { withJobLock } from '../../common/utils/job-lock.util';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../finance/ledger.service';
import { pulseStatusFromOccupancy } from '../pulse/pulse-status.util';
import { elapsedLiveMatchWhere } from '../social/match-lifecycle';

/**
 * Background sweeps that release time-bounded holds. This is what actually
 * frees a slot/claim after its window passes — the partial unique index and
 * PulseClaim state machine only *reserve* inventory, they don't expire it.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly notifications: NotificationsService,
    private readonly ledger: LedgerService,
  ) {}

  private async runJob(name: string, work: () => Promise<void>): Promise<void> {
    try {
      // One instance at a time: with replicas every @Cron fires everywhere.
      await withJobLock(this.prisma, name, work);
    } catch (err) {
      this.logger.warn(
        `${name} skipped: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async expireBookingHolds() {
    await this.runJob('expireBookingHolds', () => this.releaseExpiredBookingHolds());
  }

  private async releaseExpiredBookingHolds() {
    // Coins are reserved off the balance the moment a hold is created (see
    // BookingsService.holdSlot), so releasing an abandoned hold can no
    // longer be a blind bulk update — each row with `coinsRedeemed > 0`
    // needs its coins actually credited back, not just its status flipped.
    const expiring = await this.prisma.booking.findMany({
      where: { status: 'held', holdExpiresAt: { lt: new Date() } },
      select: { id: true, userId: true, coinsRedeemed: true },
    });
    if (!expiring.length) return;

    for (const booking of expiring) {
      await this.prisma.$transaction(async (tx) => {
        const released = await tx.booking.updateMany({
          where: { id: booking.id, status: 'held' },
          data: { status: 'cancelled', holdExpiresAt: null },
        });
        if (!released.count) return; // someone else already resolved it
        if (booking.coinsRedeemed > 0) {
          await tx.user.update({
            where: { id: booking.userId },
            data: { coinsBalance: { increment: booking.coinsRedeemed } },
          });
          await tx.coinLedgerEntry.create({
            data: {
              userId: booking.userId,
              amount: booking.coinsRedeemed,
              reason: 'booking_cancel_restore',
              bookingId: booking.id,
            },
          });
        }
        await this.ledger.syncBookingLedger(tx, booking.id, 'cancelled');
      });
    }
    this.logger.debug(`Released ${expiring.length} expired booking hold(s)`);
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async expirePulseClaims() {
    await this.runJob('expirePulseClaims', () => this.releaseExpiredPulseClaims());
  }

  private async releaseExpiredPulseClaims() {
    const expired = await this.prisma.pulseClaim.findMany({
      where: { state: 'held', holdExpiresAt: { lt: new Date() } },
    });
    for (const claim of expired) {
      const didExpire = await this.prisma.$transaction(async (tx) => {
        const changed = await tx.pulseClaim.updateMany({
          where: {
            id: claim.id,
            state: 'held',
            holdExpiresAt: { lt: new Date() },
          },
          data: { state: 'expired' },
        });
        if (changed.count !== 1) return false;
        const opportunity = await tx.pulseOpportunity.findUnique({
          where: { id: claim.opportunityId },
        });
        if (
          opportunity &&
          ['open', 'held', 'full'].includes(opportunity.status)
        ) {
          const activeCount = await tx.pulseClaim.count({
            where: {
              opportunityId: claim.opportunityId,
              state: { in: ['held', 'confirmed'] },
            },
          });
          await tx.pulseOpportunity.update({
            where: { id: claim.opportunityId },
            data: {
              status: pulseStatusFromOccupancy(
                opportunity.capacity,
                activeCount,
              ),
              version: { increment: 1 },
            },
          });
        }
        return true;
      });
      if (!didExpire) continue;
      this.emitter.emitToRoom('pulse', {
        type: 'pulse.opportunity.changed',
        opportunityId: claim.opportunityId,
      });
    }
    if (expired.length)
      this.logger.debug(`Expired ${expired.length} Pulse claim(s)`);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async expirePulseAvailability() {
    await this.runJob('expirePulseAvailability', async () => {
      await this.prisma.pulseAvailability.updateMany({
        where: { status: 'active', expiresAt: { lt: new Date() } },
        data: { status: 'expired' },
      });
    });
  }

  @Cron(CronExpression.EVERY_HOUR)
  async expirePulseOpportunities() {
    await this.runJob('expirePulseOpportunities', async () => {
      await this.prisma.pulseOpportunity.updateMany({
        where: {
          status: { in: ['open', 'held'] },
          expiresAt: { lt: new Date() },
        },
        data: { status: 'expired' },
      });
    });
  }

  /**
   * Anti-leak: at_venue commission cannot be avoided by never scanning the QR.
   * Confirmed platform bookings become `completed` 24h after slotEnd unless the
   * owner marked them no_show or cancelled in that window. `completed` triggers
   * at_venue accrual. The previous 3-hour auto-no-show job was removed because
   * it zeroed commission whenever the owner skipped check-in.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async completeStalePlatformBookings() {
    await this.runJob('completeStalePlatformBookings', () =>
      this.completeStalePlatformBookingsNow(),
    );
  }

  async completeStalePlatformBookingsNow() {
    const cutoff = new Date(Date.now() - 24 * 3_600_000);
    const stale = await this.prisma.booking.findMany({
      where: {
        source: 'platform',
        status: 'confirmed',
        checkedInAt: null,
        slotEnd: { lt: cutoff },
      },
      select: { id: true },
      take: 200,
    });
    for (const booking of stale) {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.booking.updateMany({
          where: {
            id: booking.id,
            status: 'confirmed',
            checkedInAt: null,
          },
          data: { status: 'completed' },
        });
        if (!updated.count) return;
        await this.ledger.syncBookingLedger(tx, booking.id, 'auto_completed');
      });
    }
    if (stale.length) {
      this.logger.log(
        `Auto-completed ${stale.length} stale platform booking(s) after 24h`,
      );
    }
  }

  /**
   * Cash-drawer safety net: a manual booking that starts within the hour but
   * still has money outstanding nudges the venue once. Deduped on the
   * notification payload, so a 5-minute sweep never repeats itself.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async remindUnpaidManualBookings() {
    await this.runJob('remindUnpaidManualBookings', async () => {
      await this.remindUnpaidManualBookingsNow();
    });
  }

  async remindUnpaidManualBookingsNow(now: Date = new Date()) {
    const soon = new Date(now.getTime() + 60 * 60_000);
    const rows = await this.prisma.booking.findMany({
      where: {
        source: 'manual',
        status: 'confirmed',
        paymentStatus: { in: ['pending', 'partial'] },
        slotStart: { gt: now, lte: soon },
      },
      include: {
        venue: { select: { ownerId: true, country: { select: { timezone: true } } } },
        payments: { where: { status: 'paid' }, select: { amount: true } },
      },
      take: 200,
    });
    let sent = 0;
    for (const b of rows) {
      const already = await this.prisma.notification.findFirst({
        where: {
          userId: b.venue.ownerId,
          payload: { path: ['paymentReminderFor'], equals: b.id },
        },
        select: { id: true },
      });
      if (already) continue;
      const paid = b.payments.reduce((sum, p) => sum + p.amount, 0);
      const outstanding = Math.max(0, b.totalAmount - paid);
      if (outstanding <= 0) continue;
      const tz = b.venue.country?.timezone ?? 'Africa/Cairo';
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(b.slotStart);
      const major = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(outstanding / 100);
      const who = b.guestName?.trim();
      await this.notifications.create({
        userId: b.venue.ownerId,
        category: 'system',
        titleEn: `${major} ${b.currency} still due at ${time}`,
        titleAr: `متبقي ${major} ${b.currency} الساعة ${time}`,
        bodyEn: `${who ?? 'A booking'} starts at ${time} and has not paid in full. Collect it before they play.`,
        bodyAr: `${who ? `حجز ${who}` : 'حجز'} هيبدأ ${time} ولسه ما دفعش كامل. حصّل المبلغ قبل ما يلعب.`,
        deepLink: '/owner/today',
        payload: { paymentReminderFor: b.id, venueId: b.venueId },
      });
      sent += 1;
    }
    if (sent) this.logger.log(`Sent ${sent} unpaid-booking reminder(s)`);
    return sent;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async expireInactiveCoins() {
    await this.runJob('expireInactiveCoins', () => this.expireInactiveCoinsNow());
  }

  private async expireInactiveCoinsNow() {
    // §5.1: coins expire after 6 months of account inactivity.
    //
    // This deliberately reads `lastSeenAt`, not `updatedAt` — Prisma's
    // `@updatedAt` on User bumps on *any* write to the row (a wallet credit,
    // a profile edit, even the presence gateway's own "you're online" ping on
    // every socket reconnect), so keying inactivity off it meant this never
    // fired for anyone who ever opened the app. `lastSeenAt` is the field that
    // actually means "was here." A user who never logged in at all has a null
    // `lastSeenAt`, in which case `createdAt` is the honest inactivity clock.
    const cutoff = new Date(Date.now() - 180 * 86_400_000);
    const inactiveUsers = await this.prisma.user.findMany({
      where: {
        coinsBalance: { gt: 0 },
        OR: [
          { lastSeenAt: { lt: cutoff } },
          { lastSeenAt: null, createdAt: { lt: cutoff } },
        ],
      },
      select: { id: true, coinsBalance: true },
    });
    for (const user of inactiveUsers) {
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: user.id },
          data: { coinsBalance: 0 },
        }),
        this.prisma.coinLedgerEntry.create({
          data: {
            userId: user.id,
            amount: -user.coinsBalance,
            reason: 'inactivity_expiry',
          },
        }),
      ]);
      // Zeroing a balance with no explanation reads as theft, not policy.
      await this.notifications
        .create({
          userId: user.id,
          category: 'system',
          titleEn: 'Your coins expired from inactivity',
          titleAr: 'انتهت صلاحية الكوينز بتاعتك بسبب عدم النشاط',
          bodyEn: `${user.coinsBalance} coins were cleared after 6 months away. Play a match to start earning again.`,
          bodyAr: `اتشالت ${user.coinsBalance} كوينز بعد 6 شهور بدون نشاط. العب ماتش عشان تكسب تاني.`,
          deepLink: '/app/wallet',
          payload: { coinsExpired: user.coinsBalance },
        })
        .catch(() => undefined);
    }
    if (inactiveUsers.length)
      this.logger.log(
        `Expired coins for ${inactiveUsers.length} inactive user(s)`,
      );
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async resetBrokenStreaks() {
    await this.runJob('resetBrokenStreaks', async () => {
      const cutoff = new Date(Date.now() - 48 * 3_600_000);
      const { count } = await this.prisma.user.updateMany({
        where: { streakCount: { gt: 0 }, streakUpdatedAt: { lt: cutoff } },
        data: { streakCount: 0 },
      });
      if (count) this.logger.log(`Reset ${count} broken streak(s)`);
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async expireElapsedMatchPosts() {
    await this.runJob('expireElapsedMatchPosts', async () => {
      const now = new Date();
      const { count } = await this.prisma.matchPost.updateMany({
        where: elapsedLiveMatchWhere(now),
        data: { status: 'expired' },
      });
      const { count: pulseCount } = await this.prisma.pulseOpportunity.updateMany({
        where: {
          matchPostId: { not: null },
          status: { in: ['open', 'held', 'full'] },
          OR: [
            { expiresAt: { lte: now } },
            { matchPost: { dateTime: { lte: now } } },
          ],
        },
        data: { status: 'expired' },
      });
      if (count) this.logger.log(`Expired ${count} elapsed match post(s)`);
      if (pulseCount) this.logger.log(`Closed ${pulseCount} elapsed Pulse rescue(s)`);
    });
  }

  /**
   * Nothing else in the codebase ever creates a `PulseOpportunity` row, which
   * means the Pulse feed's "rescue" column — the whole point of the page,
   * per the product's "never play short" loop — is permanently empty in
   * production no matter how many short-handed matches exist. This turns
   * every open, still-upcoming match post that still needs players into a
   * live rescue opportunity, and keeps it in sync (capacity, fullness,
   * expiry) as that match post changes.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async syncPulseRescueOpportunities() {
    await this.runJob('syncPulseRescueOpportunities', () =>
      this.syncPulseRescueOpportunitiesNow(),
    );
  }

  private async syncPulseRescueOpportunitiesNow() {
    const now = new Date();
    const openPosts = await this.prisma.matchPost.findMany({
      where: { status: 'open', playersNeeded: { gt: 0 }, dateTime: { gt: now } },
      select: {
        id: true, authorId: true, sportId: true, districtId: true,
        dateTime: true, playersNeeded: true, skillTier: true,
        costPerPlayerAmount: true, currency: true,
      },
    });
    const openPostIds = new Set(openPosts.map((p) => p.id));

    const existing = await this.prisma.pulseOpportunity.findMany({
      where: { matchPostId: { not: null }, status: { in: ['open', 'held', 'full'] } },
      select: { id: true, matchPostId: true, capacity: true },
    });
    const existingByMatchPostId = new Map(
      existing.map((o) => [o.matchPostId as string, o]),
    );

    let created = 0;
    for (const post of openPosts) {
      const current = existingByMatchPostId.get(post.id);
      if (current) {
        if (current.capacity !== post.playersNeeded) {
          await this.prisma.pulseOpportunity.update({
            where: { id: current.id },
            data: {
              capacity: post.playersNeeded,
              urgent: post.playersNeeded <= 1,
              version: { increment: 1 },
            },
          });
        }
        continue;
      }
      await this.prisma.pulseOpportunity.create({
        data: {
          kind: 'rescue',
          sportId: post.sportId,
          mode: 'casual',
          skillTier: post.skillTier ?? undefined,
          organizerUserId: post.authorId,
          matchPostId: post.id,
          districtId: post.districtId ?? undefined,
          startsAt: post.dateTime,
          // A rescue opportunity can't outlive the kickoff it's rescuing —
          // matches the "no joining after it started" guard in requestJoin.
          expiresAt: post.dateTime,
          costPerPlayerAmount: post.costPerPlayerAmount ?? 0,
          currency: post.currency,
          capacity: post.playersNeeded,
          urgent: post.playersNeeded <= 1,
        },
      });
      created++;
    }

    // The match post filled up, got cancelled, or kicked off — the
    // opportunity representing it is no longer a real rescue.
    const stale = existing.filter((o) => !openPostIds.has(o.matchPostId as string));
    if (stale.length) {
      await this.prisma.pulseOpportunity.updateMany({
        where: { id: { in: stale.map((o) => o.id) } },
        data: { status: 'expired' },
      });
    }

    if (created || stale.length)
      this.logger.log(
        `Pulse rescue sync: ${created} created, ${stale.length} closed`,
      );
  }
}
