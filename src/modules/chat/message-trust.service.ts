import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fingerprintMessage } from './message-request.rules';

export type TrustTier = 'new' | 'standard' | 'trusted';

/** New people a user may cold-message per rolling 24h, by trust tier. */
export const STRANGER_LIMITS: Record<TrustTier, number> = {
  new: 2,
  standard: 5,
  trusted: 10,
};
export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
const NEW_ACCOUNT_AGE_MS = 48 * 60 * 60 * 1000;
const TRUSTED_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TRUSTED_MIN_MATCHES = 3;
const STRIKE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const STRIKES_TO_RESTRICT = 2;
/** Identical cold text may reach at most this many different people per day. */
export const MAX_IDENTICAL_COLD_MESSAGES = 2;
/** Hard ceiling on messages from one account per minute, any thread. */
export const MESSAGES_PER_MINUTE = 30;

type Db = PrismaService | Prisma.TransactionClient;

export interface ContactQuota {
  tier: TrustTier;
  limit: number;
  used: number;
  remaining: number;
  /** When the next slot frees up; null while slots remain. */
  resetAt: Date | null;
  /** Automatically restricted after repeated blocks/reports from people contacted. */
  restricted: boolean;
  /** An admin set the limit by hand. */
  overridden: boolean;
}

@Injectable()
export class MessageTrustService {
  constructor(private readonly prisma: PrismaService) {}

  /** True when the two players already share a real connection. */
  async isKnown(a: string, b: string, db: Db = this.prisma): Promise<boolean> {
    const approved = (userId: string) => ({
      joinRequests: { some: { userId, status: 'approved' as const } },
    });
    const [friend, team, match] = await Promise.all([
      db.friendship.findFirst({
        where: {
          status: 'accepted',
          OR: [
            { requesterId: a, addresseeId: b },
            { requesterId: b, addresseeId: a },
          ],
        },
        select: { id: true },
      }),
      db.teamMember.findFirst({
        where: { userId: a, team: { members: { some: { userId: b } } } },
        select: { userId: true },
      }),
      db.matchPost.findFirst({
        where: {
          OR: [
            { authorId: a, ...approved(b) },
            { authorId: b, ...approved(a) },
            { AND: [approved(a), approved(b)] },
          ],
        },
        select: { id: true },
      }),
    ]);
    return !!(friend || team || match);
  }

  private async strikes(userId: string, db: Db): Promise<number> {
    const since = new Date(Date.now() - STRIKE_WINDOW_MS);
    const [blocks, reports] = await Promise.all([
      // Only blocks from people this user actually cold-messaged count, so a
      // stranger cannot grief someone into a restriction.
      db.userBlock.findMany({
        where: {
          blockedId: userId,
          createdAt: { gte: since },
          blocker: {
            chatParticipants: { some: { thread: { requestedById: userId } } },
          },
        },
        select: { blockerId: true },
      }),
      db.moderationReport.findMany({
        where: {
          reportedUserId: userId,
          createdAt: { gte: since },
          status: { not: 'dismissed' },
          entityType: { in: ['chat', 'player'] },
        },
        select: { reporterId: true },
      }),
    ]);
    return new Set([
      ...blocks.map((b) => b.blockerId),
      ...reports.map((r) => r.reporterId),
    ]).size;
  }

  async quota(userId: string, db: Db = this.prisma): Promise<ContactQuota> {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        createdAt: true,
        emailVerifiedAt: true,
        phone: true,
        matchesPlayed: true,
        strangerContactLimit: true,
      },
    });
    const age = Date.now() - user.createdAt.getTime();
    const verified = !!user.emailVerifiedAt || !!user.phone;
    const tier: TrustTier =
      age < NEW_ACCOUNT_AGE_MS || !verified
        ? 'new'
        : age >= TRUSTED_ACCOUNT_AGE_MS &&
            user.matchesPlayed >= TRUSTED_MIN_MATCHES
          ? 'trusted'
          : 'standard';
    const restricted = (await this.strikes(userId, db)) >= STRIKES_TO_RESTRICT;
    const overridden = user.strangerContactLimit !== null;
    const limit = overridden
      ? user.strangerContactLimit!
      : restricted
        ? 0
        : STRANGER_LIMITS[tier];

    const since = new Date(Date.now() - QUOTA_WINDOW_MS);
    const recent = await db.chatThread.findMany({
      where: { requestedById: userId, requestedAt: { gt: since } },
      select: { requestedAt: true },
      orderBy: { requestedAt: 'asc' },
    });
    const used = recent.length;
    const remaining = Math.max(0, limit - used);
    const resetAt =
      remaining > 0 || !recent.length
        ? null
        : new Date(recent[0].requestedAt!.getTime() + QUOTA_WINDOW_MS);
    return {
      tier,
      limit,
      used,
      remaining,
      resetAt,
      restricted: restricted && !overridden,
      overridden,
    };
  }

  /**
   * Spends one cold-contact slot on `threadId`. Serialised per user with an
   * advisory lock so parallel requests cannot all pass the same count.
   * Idempotent: a thread that already holds a slot is not charged again.
   */
  async claimSlot(userId: string, threadId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stranger-contact:${userId}`}))`;
      const thread = await tx.chatThread.findUniqueOrThrow({
        where: { id: threadId },
        select: { requestedAt: true },
      });
      if (thread.requestedAt) return false;
      const q = await this.quota(userId, tx);
      if (q.remaining <= 0) throw this.limitReached(q);
      await tx.chatThread.update({
        where: { id: threadId },
        data: { requestedAt: new Date() },
      });
      return true;
    });
  }

  async releaseSlot(threadId: string) {
    await this.prisma.chatThread.update({
      where: { id: threadId },
      data: { requestedAt: null },
    });
  }

  limitReached(q: ContactQuota): ForbiddenException {
    return new ForbiddenException({
      code: q.restricted ? 'CONTACT_RESTRICTED' : 'CONTACT_LIMIT_REACHED',
      message: q.restricted
        ? 'Messaging new people is paused on your account'
        : 'You have reached today’s limit for messaging new people',
      limit: q.limit,
      resetAt: q.resetAt,
    });
  }

  async assertNotBursting(userId: string) {
    const recent = await this.prisma.chatMessage.count({
      where: {
        senderId: userId,
        createdAt: { gt: new Date(Date.now() - 60_000) },
      },
    });
    if (recent >= MESSAGES_PER_MINUTE)
      throw new ForbiddenException({
        code: 'MESSAGE_RATE_LIMITED',
        message: 'You are sending messages too quickly',
      });
  }

  /** Same text already sent as a cold message to too many different people. */
  async assertNotMassMessaging(
    userId: string,
    threadId: string,
    fingerprint: string,
  ) {
    if (!fingerprint) return;
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        senderId: userId,
        deletedAt: null,
        createdAt: { gt: new Date(Date.now() - QUOTA_WINDOW_MS) },
        thread: { requestedById: userId, id: { not: threadId } },
      },
      select: { text: true, threadId: true },
      take: 200,
    });
    const others = new Set(
      rows
        .filter((r) => r.text && fingerprintMessage(r.text) === fingerprint)
        .map((r) => r.threadId),
    );
    if (others.size >= MAX_IDENTICAL_COLD_MESSAGES)
      throw new ForbiddenException({
        code: 'MESSAGE_REQUEST_DUPLICATE',
        message:
          'Please write a personal message instead of repeating the same one',
      });
  }
}
