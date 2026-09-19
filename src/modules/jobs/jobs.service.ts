import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { NotificationsService } from '../notifications/notifications.service';
import { pulseStatusFromOccupancy } from '../pulse/pulse-status.util';

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
  ) {}

  private async runJob(name: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
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

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async markNoShows() {
    await this.runJob('markNoShows', async () => {
      const cutoff = new Date(Date.now() - 3 * 3_600_000);
      const { count } = await this.prisma.booking.updateMany({
        where: {
          status: 'confirmed',
          slotEnd: { lt: cutoff },
          checkedInAt: null,
        },
        data: { status: 'no_show' },
      });
      if (count) this.logger.log(`Marked ${count} booking(s) as no-show`);
    });
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
