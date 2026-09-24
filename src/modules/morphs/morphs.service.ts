import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'crypto';
import type { MorphSource, MorphTier, Prisma } from '@prisma/client';
import { ApiException } from '../../common/errors/api-exception';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import {
  CLASSIC_MORPH_ID,
  EPIC_PITY_ROLLS,
  MISK_PITY_ROLLS,
  MORPH_CATALOG,
  MORPH_CATALOG_VERSION,
  MORPH_ROLL_COOLDOWN_MS,
  TIER_ODDS_BP,
  isKnownMorph,
  morphById,
} from './morph-catalog';
import { rollMorph } from './morph-roll.util';
import {
  evaluateQuota,
  policyFromEnv,
  quotaDayBounds,
  type MorphRollPolicy,
  type QuotaState,
} from './morph-quota.util';
import { lobbyMorphsEnabled } from './morphs-flag';

/** The client-facing slice of a quota evaluation. */
export interface MorphQuotaView {
  remainingFree: number | null;
  bonusRolls: number;
  resetsAt: string | null;
}

export interface MorphRollResponse {
  rollId: string;
  morphId: string;
  tier: MorphTier;
  isNew: boolean;
  timesObtained: number;
  pityApplied: MorphTier | null;
  equippedMorphId: string;
  progress: { owned: number; total: number };
  quota: MorphQuotaView;
}

type Tx = Prisma.TransactionClient;

type RollOutcome =
  | { kind: 'replay'; response: MorphRollResponse }
  | { kind: 'fresh'; response: MorphRollResponse; squadId: string | null };

const MARK_SEEN_MAX = 50;

@Injectable()
export class MorphsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly config: ConfigService,
  ) {}

  /** Re-read on every call so a config reload never needs a code change. */
  private policy(): MorphRollPolicy {
    return policyFromEnv(this.config.get<string>('MORPH_DAILY_FREE_ROLLS'));
  }

  catalog() {
    return {
      catalogVersion: MORPH_CATALOG_VERSION,
      morphs: MORPH_CATALOG.map((d) => ({
        id: d.id,
        tier: d.tier,
        rollable: d.rollable,
        sinceVersion: d.sinceVersion,
      })),
      odds: TIER_ODDS_BP,
      pity: { epicEvery: EPIC_PITY_ROLLS, miskEvery: MISK_PITY_ROLLS },
    };
  }

  async me(userId: string) {
    if (!lobbyMorphsEnabled(this.config)) return { enabled: false };
    const profile = await this.prisma.userMorphProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
      include: { user: { select: { createdAt: true } } },
    });
    const rows = await this.prisma.userMorph.findMany({
      where: { userId },
      orderBy: { firstObtainedAt: 'desc' },
    });
    // Rows for ids the current catalog no longer knows are hidden, never deleted.
    const known = rows.filter((r) => morphById(r.morphId));
    const now = new Date();
    const quota = await this.quotaFor(
      this.prisma,
      userId,
      profile.bonusRolls,
      now,
    );
    return {
      enabled: true,
      catalogVersion: MORPH_CATALOG_VERSION,
      equippedMorphId: isKnownMorph(profile.equippedMorphId)
        ? profile.equippedMorphId
        : CLASSIC_MORPH_ID,
      owned: [
        {
          morphId: CLASSIC_MORPH_ID,
          tier: null,
          source: 'DEFAULT' as MorphSource,
          timesObtained: 1,
          firstObtainedAt: profile.user.createdAt.toISOString(),
          isNew: false,
        },
        ...known.map((r) => ({
          morphId: r.morphId,
          tier: morphById(r.morphId)!.tier,
          source: r.source,
          timesObtained: r.timesObtained,
          firstObtainedAt: r.firstObtainedAt.toISOString(),
          isNew: r.seenAt === null,
        })),
      ],
      progress: { owned: known.length, total: MORPH_CATALOG.length },
      quota: this.quotaView(quota),
      cooldownMs: MORPH_ROLL_COOLDOWN_MS,
      odds: TIER_ODDS_BP,
      pity: { epicEvery: EPIC_PITY_ROLLS, miskEvery: MISK_PITY_ROLLS },
    };
  }

  async roll(userId: string, clientRollId: string): Promise<MorphRollResponse> {
    const previous = await this.prisma.morphRoll.findUnique({
      where: { userId_clientRollId: { userId, clientRollId } },
    });
    if (previous) return this.replay(this.prisma, previous);

    const outcome = await this.prisma.$transaction(
      async (tx): Promise<RollOutcome> => {
        await tx.userMorphProfile.upsert({
          where: { userId },
          create: { userId },
          update: {},
        });
        // Serializes double taps and multiple tabs of one user (same idea as the squad seat lock).
        await tx.$executeRaw`SELECT 1 FROM "UserMorphProfile" WHERE "userId" = ${userId} FOR UPDATE`;
        // A concurrent retry with the same key may have committed while we waited on the lock.
        const raced = await tx.morphRoll.findUnique({
          where: { userId_clientRollId: { userId, clientRollId } },
        });
        if (raced)
          return { kind: 'replay', response: await this.replay(tx, raced) };

        const profile = await tx.userMorphProfile.findUniqueOrThrow({
          where: { userId },
        });
        const now = new Date();
        if (profile.lastRollAt) {
          const elapsed = now.getTime() - profile.lastRollAt.getTime();
          if (elapsed < MORPH_ROLL_COOLDOWN_MS) {
            throw new ApiException(
              HttpStatus.TOO_MANY_REQUESTS,
              'MORPH_COOLDOWN',
              'Wait a moment before changing again',
              { retryAfterMs: MORPH_ROLL_COOLDOWN_MS - elapsed },
            );
          }
        }

        const quota = await this.quotaFor(tx, userId, profile.bonusRolls, now);
        if (!quota.allowed) {
          throw new ApiException(
            HttpStatus.TOO_MANY_REQUESTS,
            'MORPH_QUOTA_EXHAUSTED',
            'No rolls left for today',
            { resetsAt: quota.resetsAt },
          );
        }

        const ownedRows = await tx.userMorph.findMany({
          where: { userId },
          select: { morphId: true },
        });
        const ownedIds = new Set(ownedRows.map((r) => r.morphId));
        const result = rollMorph({
          catalog: MORPH_CATALOG,
          equippedMorphId: profile.equippedMorphId,
          ownedIds,
          rollsSinceEpicOrBetter: profile.rollsSinceEpicOrBetter,
          rollsSinceMisk: profile.rollsSinceMisk,
          randomInt: (max) => randomInt(max),
        });
        const wasNew = !ownedIds.has(result.morphId);
        const owned = await tx.userMorph.upsert({
          where: { userId_morphId: { userId, morphId: result.morphId } },
          create: {
            userId,
            morphId: result.morphId,
            source: 'ROLL',
            firstObtainedAt: now,
            lastObtainedAt: now,
          },
          update: { timesObtained: { increment: 1 }, lastObtainedAt: now },
        });
        const usesBonus = quota.source === 'BONUS';
        const updated = await tx.userMorphProfile.update({
          where: { userId },
          data: {
            equippedMorphId: result.morphId,
            rollsSinceEpicOrBetter: result.nextRollsSinceEpicOrBetter,
            rollsSinceMisk: result.nextRollsSinceMisk,
            totalRolls: { increment: 1 },
            lastRollAt: now,
            ...(usesBonus ? { bonusRolls: { decrement: 1 } } : {}),
          },
        });
        const membership = await tx.squadMember.findFirst({
          where: { userId },
          select: { squadId: true },
        });
        const roll = await tx.morphRoll.create({
          data: {
            userId,
            morphId: result.morphId,
            tier: result.tier,
            wasNew,
            pityApplied: result.pityApplied,
            quotaKind: usesBonus ? 'BONUS' : 'FREE',
            clientRollId,
            squadId: membership?.squadId ?? null,
            catalogVersion: MORPH_CATALOG_VERSION,
          },
        });
        const ownedKnown = [...ownedIds, result.morphId].filter((id) =>
          morphById(id),
        );
        const after = await this.quotaFor(tx, userId, updated.bonusRolls, now);
        const response: MorphRollResponse = {
          rollId: roll.id,
          morphId: result.morphId,
          tier: result.tier,
          isNew: wasNew,
          timesObtained: owned.timesObtained,
          pityApplied: result.pityApplied,
          equippedMorphId: result.morphId,
          progress: {
            owned: new Set(ownedKnown).size,
            total: MORPH_CATALOG.length,
          },
          quota: this.quotaView(after),
        };
        return {
          kind: 'fresh',
          response,
          squadId: membership?.squadId ?? null,
        };
      },
    );

    if (outcome.kind === 'replay') return outcome.response;
    const res = outcome.response;
    this.broadcast(userId, outcome.squadId, {
      morphId: res.morphId,
      tier: res.tier,
      reason: 'roll',
      rollId: res.rollId,
      isNew: res.isNew,
    });
    return res;
  }

  async equip(userId: string, morphId: string) {
    if (!isKnownMorph(morphId)) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'MORPH_UNKNOWN',
        'Unknown morph',
      );
    }
    if (morphId !== CLASSIC_MORPH_ID) {
      const owned = await this.prisma.userMorph.findUnique({
        where: { userId_morphId: { userId, morphId } },
        select: { id: true },
      });
      if (!owned)
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          'MORPH_NOT_OWNED',
          'You do not own this morph',
        );
    }
    const profile = await this.prisma.userMorphProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    if (profile.equippedMorphId === morphId)
      return { equippedMorphId: morphId, changed: false };
    await this.prisma.userMorphProfile.update({
      where: { userId },
      data: { equippedMorphId: morphId },
    });
    const membership = await this.prisma.squadMember.findFirst({
      where: { userId },
      select: { squadId: true },
    });
    this.broadcast(userId, membership?.squadId ?? null, {
      morphId,
      tier: morphById(morphId)?.tier ?? null,
      reason: 'equip',
    });
    return { equippedMorphId: morphId, changed: true };
  }

  async markSeen(userId: string, morphIds: string[]) {
    const ids = [...new Set(morphIds)].slice(0, MARK_SEEN_MAX);
    if (!ids.length) return { updated: 0 };
    const { count } = await this.prisma.userMorph.updateMany({
      where: { userId, morphId: { in: ids }, seenAt: null },
      data: { seenAt: new Date() },
    });
    return { updated: count };
  }

  /** Admin: give a user a morph (source GRANT). Does not equip. Audited. */
  async grant(adminId: string, userId: string, morphId: string) {
    if (!morphById(morphId)) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'MORPH_UNKNOWN',
        'Unknown morph',
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user)
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'USER_NOT_FOUND',
        'User not found',
      );
    const granted = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.userMorph.findUnique({
        where: { userId_morphId: { userId, morphId } },
        select: { id: true },
      });
      if (!existing)
        await tx.userMorph.create({
          data: { userId, morphId, source: 'GRANT' },
        });
      await tx.auditLogEntry.create({
        data: {
          actorUserId: adminId,
          action: 'admin.morph.grant',
          targetType: 'user',
          targetId: userId,
          metadata: { morphId, alreadyOwned: Boolean(existing) },
        },
      });
      return !existing;
    });
    if (granted) {
      const profile = await this.prisma.userMorphProfile.findUnique({
        where: { userId },
        select: { equippedMorphId: true },
      });
      this.emitter.emitToUser(userId, {
        type: 'morph.self.updated',
        equippedMorphId: profile?.equippedMorphId ?? CLASSIC_MORPH_ID,
      });
    }
    return { userId, morphId, granted };
  }

  /** Admin: roll analytics for the last `days` days. */
  async stats(days: number) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const where = { createdAt: { gte: since } };
    const [byTier, byMorph, rollers] = await Promise.all([
      this.prisma.morphRoll.groupBy({
        by: ['tier'],
        where,
        _count: { _all: true },
      }),
      this.prisma.morphRoll.groupBy({
        by: ['morphId'],
        where,
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT "userId")::bigint AS count FROM "MorphRoll" WHERE "createdAt" >= ${since}`,
    ]);
    const perTier: Record<MorphTier, number> = { COMMON: 0, EPIC: 0, MISK: 0 };
    for (const row of byTier) perTier[row.tier] = row._count._all;
    return {
      days,
      since: since.toISOString(),
      totalRolls: perTier.COMMON + perTier.EPIC + perTier.MISK,
      perTier,
      perMorph: Object.fromEntries(
        byMorph
          .map((r) => [r.morphId, r._count._all] as const)
          .sort((a, b) => b[1] - a[1]),
      ),
      uniqueRollers: Number(rollers[0]?.count ?? 0),
      miskPulls: perTier.MISK,
    };
  }

  private async quotaFor(
    db: Tx,
    userId: string,
    bonusRolls: number,
    now: Date,
  ): Promise<QuotaState> {
    const policy = this.policy();
    let freeRollsToday = 0;
    if (policy.kind === 'daily') {
      const { start, end } = quotaDayBounds(now, policy.timeZone);
      freeRollsToday = await db.morphRoll.count({
        where: {
          userId,
          quotaKind: 'FREE',
          createdAt: { gte: start, lt: end },
        },
      });
    }
    return evaluateQuota(policy, freeRollsToday, bonusRolls, now);
  }

  private quotaView(q: QuotaState): MorphQuotaView {
    return {
      remainingFree: q.remainingFree,
      bonusRolls: q.bonusRolls,
      resetsAt: q.resetsAt,
    };
  }

  /** Same result for a retried `clientRollId`, with no side effects. */
  private async replay(
    db: Tx,
    roll: {
      id: string;
      userId: string;
      morphId: string;
      tier: MorphTier;
      wasNew: boolean;
      pityApplied: MorphTier | null;
    },
  ): Promise<MorphRollResponse> {
    const [owned, profile, ownedRows] = await Promise.all([
      db.userMorph.findUnique({
        where: {
          userId_morphId: { userId: roll.userId, morphId: roll.morphId },
        },
        select: { timesObtained: true },
      }),
      db.userMorphProfile.findUnique({ where: { userId: roll.userId } }),
      db.userMorph.findMany({
        where: { userId: roll.userId },
        select: { morphId: true },
      }),
    ]);
    const quota = await this.quotaFor(
      db,
      roll.userId,
      profile?.bonusRolls ?? 0,
      new Date(),
    );
    return {
      rollId: roll.id,
      morphId: roll.morphId,
      tier: roll.tier,
      isNew: roll.wasNew,
      timesObtained: owned?.timesObtained ?? 1,
      pityApplied: roll.pityApplied,
      equippedMorphId: profile?.equippedMorphId ?? roll.morphId,
      progress: {
        owned: ownedRows.filter((r) => morphById(r.morphId)).length,
        total: MORPH_CATALOG.length,
      },
      quota: this.quotaView(quota),
    };
  }

  private broadcast(
    userId: string,
    squadId: string | null,
    change: {
      morphId: string;
      tier: MorphTier | null;
      reason: 'roll' | 'equip';
      rollId?: string;
      isNew?: boolean;
    },
  ): void {
    const at = new Date().toISOString();
    if (squadId) {
      this.emitter.emitToRoom(`squad:${squadId}`, {
        type: 'squad.member.morph',
        squadId,
        userId,
        morphId: change.morphId,
        tier: change.tier,
        reason: change.reason,
        ...(change.rollId ? { rollId: change.rollId } : {}),
        ...(change.isNew !== undefined ? { isNew: change.isNew } : {}),
        at,
      });
    }
    this.emitter.emitToUser(userId, {
      type: 'morph.self.updated',
      equippedMorphId: change.morphId,
      ...(change.rollId ? { rollId: change.rollId } : {}),
    });
  }
}
