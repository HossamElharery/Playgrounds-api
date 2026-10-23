import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { withJobLock } from '../../../common/utils/job-lock.util';
import { PrismaService } from '../../prisma/prisma.service';
import { CoinGrantService } from '../coin-grant.service';
import { TRUST_COOLOFF_MS, VENUE_NEW_TRUST_PER_WEEK } from '../coins-policy';
import { BookingQualificationService, type Qualification } from './booking-qualification.service';
import { DeviceLinksService } from './device-links.service';

export type TrustOutcome = 'already' | 'blocked' | 'trusted' | 'candidate' | 'venue_capped';
type TrustedHandler = (userId: string, bookingId: string | null) => Promise<void>;

/**
 * Who counts as a real player. A qualifying check-in does not trust anybody
 * at once: it makes them a candidate, and 48 hours later the booking is
 * checked again (still completed, venue not frozen since, nobody on the
 * same device already trusted). A venue can only create a few candidates a
 * week, and an admin can freeze a venue or revoke a player and take the
 * coins back. Real payment through the gateway is the one fast path.
 */
@Injectable()
export class TrustService {
  private readonly logger = new Logger(TrustService.name);
  private readonly handlers: TrustedHandler[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: CoinGrantService,
    private readonly links: DeviceLinksService,
    private readonly qualification: BookingQualificationService,
  ) {}

  /** Called once a player becomes trusted (e.g. to settle a referral). */
  onTrusted(handler: TrustedHandler): void {
    this.handlers.push(handler);
  }

  async considerCheckIn(
    userId: string,
    bookingId: string,
    q: Extract<Qualification, { ok: true }>,
  ): Promise<TrustOutcome> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { trustedAt: true, trustCandidateAt: true, rewardsBlockedAt: true },
    });
    if (!user) return 'blocked';
    if (user.rewardsBlockedAt) return 'blocked';
    if (user.trustedAt) return 'already';
    if (q.moneyVerified) return (await this.trustNow(userId, bookingId)) ? 'trusted' : 'already';
    if (user.trustCandidateAt) return 'candidate';
    const recent = await this.prisma.user.count({
      where: {
        trustVenueId: q.venueId,
        trustCandidateAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
      },
    });
    if (recent >= VENUE_NEW_TRUST_PER_WEEK) return 'venue_capped';
    const claimed = await this.prisma.user.updateMany({
      where: { id: userId, trustedAt: null, trustCandidateAt: null },
      data: { trustCandidateAt: new Date(), trustBookingId: bookingId, trustVenueId: q.venueId },
    });
    // Either we just made them a candidate or a parallel request did.
    void claimed;
    return 'candidate';
  }

  /** Trust now (payment verified, cool-off over, or an admin said so). */
  async trustNow(userId: string, bookingId: string | null): Promise<boolean> {
    const became = await this.grants.markTrusted(userId);
    if (!became) return false;
    for (const handler of this.handlers) {
      try {
        await handler(userId, bookingId);
      } catch (err) {
        this.logger.warn(`trusted handler failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return true;
  }

  @Cron('*/10 * * * *')
  async sweep(): Promise<void> {
    try {
      await withJobLock(this.prisma, 'trustPromote', async () => {
        await this.promoteDue();
      });
    } catch (err) {
      this.logger.warn(`trust sweep skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  async promoteDue(): Promise<{ trusted: number; dropped: number }> {
    const due = await this.prisma.user.findMany({
      where: {
        trustedAt: null,
        rewardsBlockedAt: null,
        trustCandidateAt: { not: null, lte: new Date(Date.now() - TRUST_COOLOFF_MS) },
      },
      select: { id: true, trustBookingId: true },
      take: 100,
      orderBy: { trustCandidateAt: 'asc' },
    });
    let trusted = 0;
    let dropped = 0;
    for (const u of due) {
      try {
        const q = u.trustBookingId ? await this.qualification.assess(u.trustBookingId) : null;
        let ok = !!q?.ok;
        if (ok) {
          const linked = await this.links.linkedIds(u.id);
          if (linked.size) {
            const trustedTwin = await this.prisma.user.count({
              where: { id: { in: [...linked] }, trustedAt: { not: null } },
            });
            if (trustedTwin > 0) ok = false;
          }
        }
        if (ok && (await this.trustNow(u.id, u.trustBookingId))) trusted += 1;
        else if (!ok) {
          dropped += 1;
          await this.prisma.user.updateMany({
            where: { id: u.id, trustedAt: null },
            data: { trustCandidateAt: null, trustBookingId: null, trustVenueId: null },
          });
        }
      } catch (err) {
        this.logger.warn(`trust check failed for ${u.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { trusted, dropped };
  }

  /** Admin: take trust away, void what is waiting and (optionally) take back recent coins. */
  async revoke(
    userId: string,
    actorId: string,
    opts: { clawback: boolean; block: boolean },
  ): Promise<{ clawedBack: number }> {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          trustedAt: null,
          trustCandidateAt: null,
          trustBookingId: null,
          trustVenueId: null,
          ...(opts.block ? { rewardsBlockedAt: new Date() } : {}),
        },
      });
      await tx.coinGrant.updateMany({
        where: { userId, status: 'pending' },
        data: { status: 'void' },
      });
      let clawedBack = 0;
      if (opts.clawback) {
        const paid = await tx.coinGrant.aggregate({
          where: { userId, status: 'paid', paidAt: { gte: since } },
          _sum: { amount: true },
        });
        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { coinsBalance: true },
        });
        clawedBack = Math.min(paid._sum.amount ?? 0, user.coinsBalance);
        if (clawedBack > 0) {
          await tx.user.update({
            where: { id: userId },
            data: { coinsBalance: { decrement: clawedBack } },
          });
          await tx.coinLedgerEntry.create({
            data: { userId, amount: -clawedBack, reason: 'rewards_revoked' },
          });
        }
      }
      await tx.auditLogEntry.create({
        data: {
          actorUserId: actorId,
          action: 'rewards.revoke_trust',
          targetType: 'user',
          targetId: userId,
          metadata: { ...opts, clawedBack },
        },
      });
      return { clawedBack };
    });
    return result;
  }

  /** Admin: trust a player directly (and clear any block). */
  async adminTrust(userId: string, actorId: string): Promise<boolean> {
    await this.prisma.user.update({ where: { id: userId }, data: { rewardsBlockedAt: null } });
    await this.prisma.auditLogEntry.create({
      data: { actorUserId: actorId, action: 'rewards.admin_trust', targetType: 'user', targetId: userId },
    });
    return this.trustNow(userId, null);
  }

  async setBlocked(userId: string, actorId: string, on: boolean): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { rewardsBlockedAt: on ? new Date() : null },
    });
    await this.prisma.auditLogEntry.create({
      data: {
        actorUserId: actorId,
        action: on ? 'rewards.block_user' : 'rewards.unblock_user',
        targetType: 'user',
        targetId: userId,
      },
    });
  }

  /** Admin: stop a venue from creating trusted players or coins; optionally undo its recent players. */
  async setVenueFrozen(
    venueId: string,
    actorId: string,
    on: boolean,
    revokeRecent: boolean,
  ): Promise<{ revoked: number }> {
    await this.prisma.venue.update({
      where: { id: venueId },
      data: { rewardsFrozenAt: on ? new Date() : null },
    });
    await this.prisma.auditLogEntry.create({
      data: {
        actorUserId: actorId,
        action: on ? 'rewards.freeze_venue' : 'rewards.unfreeze_venue',
        targetType: 'venue',
        targetId: venueId,
        metadata: { revokeRecent },
      },
    });
    let revoked = 0;
    if (on && revokeRecent) {
      const recent = await this.prisma.user.findMany({
        where: {
          trustVenueId: venueId,
          trustCandidateAt: { gte: new Date(Date.now() - 14 * 86_400_000) },
        },
        select: { id: true },
        take: 500,
      });
      for (const u of recent) {
        await this.revoke(u.id, actorId, { clawback: true, block: false });
        revoked += 1;
      }
    }
    return { revoked };
  }
}
