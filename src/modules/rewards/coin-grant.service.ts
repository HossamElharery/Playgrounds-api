import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { withJobLock } from '../../common/utils/job-lock.util';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ENGAGEMENT_DAILY_CAP_COINS,
  PENDING_GRANT_TTL_MS,
} from './coins-policy';

export interface GrantInput {
  userId: string;
  amount: number;
  /** Ledger reason, e.g. `achievement:penalties_win_10`. */
  reason: string;
  /** Unique per user: the same reward can never be created twice. */
  refKey: string;
  /** Wait until the player is trusted (a paid booking was checked in). Default true. */
  requiresTrust?: boolean;
  /** Counts toward the rolling 24h cap on engagement coins. */
  dailyCapped?: boolean;
  /** Keep the reward pending for this long before it can be paid. */
  holdMs?: number;
  bookingId?: string;
}

export type GrantOutcome =
  | { status: 'paid'; amount: number }
  | { status: 'pending'; amount: number }
  | { status: 'void'; amount: 0 }
  | { status: 'duplicate'; amount: 0 };

const NOTE: Record<string, { en: string; ar: string }> = {
  referral_bonus: { en: 'Referral reward', ar: 'مكافأة دعوة صديق' },
  match_played: { en: 'You played a match', ar: 'لعبت ماتش' },
  post_match_rating: { en: 'Post-match rating', ar: 'تقييم بعد الماتش' },
  review_with_photo: { en: 'Review with photos', ar: 'تقييم بصور' },
};

function noteFor(reason: string): { en: string; ar: string } | null {
  // These tell the player themselves (a nicer message, or none at all).
  if (['daily_checkin', 'post_engagement_reward'].includes(reason)) return null;
  const head = reason.split(':')[0];
  if (head === 'achievement') return null;
  return NOTE[head] ?? { en: 'Coins reward', ar: 'مكافأة كوينز' };
}

/**
 * The only door through which engagement coins reach a balance.
 *
 * A reward is first recorded as a CoinGrant (idempotent by `refKey`). It is
 * paid right away only when the player is trusted, any hold has passed and
 * the 24h engagement cap has room; otherwise it stays pending and is paid by
 * `releaseForUser` (the moment the player becomes trusted) or the sweep.
 */
@Injectable()
export class CoinGrantService {
  private readonly logger = new Logger(CoinGrantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async grant(input: GrantInput): Promise<GrantOutcome> {
    const amount = Math.trunc(input.amount);
    if (!(amount > 0)) return { status: 'void', amount: 0 };
    let id: string;
    try {
      const row = await this.prisma.coinGrant.create({
        data: {
          userId: input.userId,
          amount,
          reason: input.reason,
          refKey: input.refKey,
          requiresTrust: input.requiresTrust ?? true,
          dailyCapped: input.dailyCapped ?? false,
          releaseAt: input.holdMs ? new Date(Date.now() + input.holdMs) : null,
          bookingId: input.bookingId ?? null,
        },
        select: { id: true },
      });
      id = row.id;
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        return { status: 'duplicate', amount: 0 };
      throw error;
    }
    return this.release(id);
  }

  /** Pays one grant if it is allowed to be paid now. Safe to call any number of times. */
  async release(grantId: string): Promise<GrantOutcome> {
    const paid = await this.prisma.$transaction(
      async (tx) => {
        const grant = await tx.coinGrant.findUnique({
          where: { id: grantId },
          include: { user: { select: { trustedAt: true, status: true } } },
        });
        if (!grant) return { status: 'void', amount: 0 } as GrantOutcome;
        if (grant.status === 'paid')
          return { status: 'paid', amount: grant.amount } as GrantOutcome;
        if (grant.status === 'void')
          return { status: 'void', amount: 0 } as GrantOutcome;
        if (grant.releaseAt && grant.releaseAt.getTime() > Date.now())
          return { status: 'pending', amount: grant.amount } as GrantOutcome;
        if (grant.requiresTrust && !grant.user.trustedAt)
          return { status: 'pending', amount: grant.amount } as GrantOutcome;
        if (grant.user.status !== 'active')
          return { status: 'pending', amount: grant.amount } as GrantOutcome;

        let pay = grant.amount;
        if (grant.dailyCapped) {
          // One player's engagement payouts are decided one at a time.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${grant.userId}))`;
          const since = new Date(Date.now() - 86_400_000);
          const sum = await tx.coinGrant.aggregate({
            where: {
              userId: grant.userId,
              dailyCapped: true,
              status: 'paid',
              paidAt: { gte: since },
            },
            _sum: { amount: true },
          });
          const room = ENGAGEMENT_DAILY_CAP_COINS - (sum._sum.amount ?? 0);
          if (room <= 0) {
            await tx.coinGrant.updateMany({
              where: { id: grant.id, status: 'pending' },
              data: { status: 'void' },
            });
            return { status: 'void', amount: 0 } as GrantOutcome;
          }
          pay = Math.min(pay, room);
        }

        const claimed = await tx.coinGrant.updateMany({
          where: { id: grant.id, status: 'pending' },
          data: { status: 'paid', paidAt: new Date(), amount: pay },
        });
        if (claimed.count !== 1)
          return { status: 'duplicate', amount: 0 } as GrantOutcome;
        await tx.user.update({
          where: { id: grant.userId },
          data: { coinsBalance: { increment: pay } },
        });
        await tx.coinLedgerEntry.create({
          data: {
            userId: grant.userId,
            amount: pay,
            reason: grant.reason,
            bookingId: grant.bookingId,
          },
        });
        return { status: 'paid', amount: pay } as GrantOutcome;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    if (paid.status === 'paid') await this.tellPlayer(grantId).catch(() => undefined);
    return paid;
  }

  /** The player just became trusted: pay everything that was waiting for that. */
  async releaseForUser(userId: string): Promise<number> {
    const waiting = await this.prisma.coinGrant.findMany({
      where: {
        userId,
        status: 'pending',
        OR: [{ releaseAt: null }, { releaseAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: 200,
    });
    let paid = 0;
    for (const g of waiting) {
      const out = await this.releaseSafely(g.id);
      if (out?.status === 'paid') paid += out.amount;
    }
    return paid;
  }

  /** First paid booking checked in at a venue: this player is real. */
  async markTrusted(userId: string): Promise<boolean> {
    const changed = await this.prisma.user.updateMany({
      where: { id: userId, trustedAt: null },
      data: { trustedAt: new Date() },
    });
    if (!changed.count) return false;
    await this.releaseForUser(userId);
    return true;
  }

  /** What the wallet shows as "waiting for your first booking". */
  async pendingSummary(userId: string) {
    const [user, agg] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { trustedAt: true },
      }),
      this.prisma.coinGrant.aggregate({
        where: { userId, status: 'pending' },
        _sum: { amount: true },
        _count: true,
      }),
    ]);
    return {
      trusted: !!user?.trustedAt,
      pendingCoins: agg._sum.amount ?? 0,
      pendingCount: agg._count,
    };
  }

  @Cron('*/10 * * * *')
  async sweep(): Promise<void> {
    try {
      await withJobLock(this.prisma, 'coinGrantSweep', async () => {
        await this.sweepNow();
      });
    } catch (err) {
      this.logger.warn(
        `coin grant sweep skipped: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async sweepNow(): Promise<{ paid: number; voided: number }> {
    const voided = await this.prisma.coinGrant.updateMany({
      where: {
        status: 'pending',
        createdAt: { lt: new Date(Date.now() - PENDING_GRANT_TTL_MS) },
      },
      data: { status: 'void' },
    });
    const due = await this.prisma.coinGrant.findMany({
      where: {
        status: 'pending',
        releaseAt: { not: null, lte: new Date() },
      },
      orderBy: { releaseAt: 'asc' },
      select: { id: true },
      take: 200,
    });
    let paid = 0;
    for (const g of due) {
      const out = await this.releaseSafely(g.id);
      if (out?.status === 'paid') paid += 1;
    }
    return { paid, voided: voided.count };
  }

  /** One bad row must not stop the rest of a batch. */
  private async releaseSafely(grantId: string): Promise<GrantOutcome | null> {
    try {
      return await this.release(grantId);
    } catch (err) {
      this.logger.warn(
        `grant ${grantId} not released: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  private async tellPlayer(grantId: string): Promise<void> {
    const grant = await this.prisma.coinGrant.findUnique({
      where: { id: grantId },
      select: { id: true, userId: true, amount: true, reason: true },
    });
    if (!grant) return;
    const note = noteFor(grant.reason);
    if (!note) return;
    await this.notifications.create({
      userId: grant.userId,
      category: 'rewards',
      titleEn: `+${grant.amount} coins`,
      titleAr: `+${grant.amount} كوينز`,
      bodyEn: note.en,
      bodyAr: note.ar,
      deepLink: '/app/wallet',
      payload: { coins: grant.amount, reason: grant.reason },
      dedupKey: `coin-grant:${grant.id}`,
    });
  }
}
