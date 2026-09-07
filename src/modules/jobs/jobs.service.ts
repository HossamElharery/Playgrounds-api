import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
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
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async expireBookingHolds() {
    const { count } = await this.prisma.booking.updateMany({
      where: { status: 'held', holdExpiresAt: { lt: new Date() } },
      data: { status: 'cancelled', holdExpiresAt: null },
    });
    if (count) this.logger.debug(`Released ${count} expired booking hold(s)`);
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async expirePulseClaims() {
    const expired = await this.prisma.pulseClaim.findMany({
      where: { state: 'held', holdExpiresAt: { lt: new Date() } },
    });
    for (const claim of expired) {
      await this.prisma.$transaction(async (tx) => {
        await tx.pulseClaim.update({
          where: { id: claim.id },
          data: { state: 'expired' },
        });
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
      });
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
    await this.prisma.pulseAvailability.updateMany({
      where: { status: 'active', expiresAt: { lt: new Date() } },
      data: { status: 'expired' },
    });
  }

  @Cron(CronExpression.EVERY_HOUR)
  async expirePulseOpportunities() {
    await this.prisma.pulseOpportunity.updateMany({
      where: {
        status: { in: ['open', 'held'] },
        expiresAt: { lt: new Date() },
      },
      data: { status: 'expired' },
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async markNoShows() {
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
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async expireInactiveCoins() {
    // §5.1: coins expire after 6 months of account inactivity.
    const cutoff = new Date(Date.now() - 180 * 86_400_000);
    const inactiveUsers = await this.prisma.user.findMany({
      where: { updatedAt: { lt: cutoff }, coinsBalance: { gt: 0 } },
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
    }
    if (inactiveUsers.length)
      this.logger.log(
        `Expired coins for ${inactiveUsers.length} inactive user(s)`,
      );
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async resetBrokenStreaks() {
    const cutoff = new Date(Date.now() - 48 * 3_600_000);
    const { count } = await this.prisma.user.updateMany({
      where: { streakCount: { gt: 0 }, streakUpdatedAt: { lt: cutoff } },
      data: { streakCount: 0 },
    });
    if (count) this.logger.log(`Reset ${count} broken streak(s)`);
  }
}
