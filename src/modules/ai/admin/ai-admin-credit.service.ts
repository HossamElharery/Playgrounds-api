import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiException } from '../../../common/errors/api-exception';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import {
  DAY_MS,
  subscriptionStanding,
} from '../../subscriptions/subscription-state.util';
import { VenueAiCreditService } from '../credit/venue-ai-credit.service';
import {
  CREDIT_ROW_SELECT,
  CREDIT_WINDOW_DAYS,
  freshAiCycle,
  type VenueAiCreditView,
} from '../credit/venue-ai-credit';
import { fromMicros, toMicros } from '../ai-day';
import type { AiCreditTopUpDto, UpdateVenueCreditDto } from './ai-admin.dto';

/** Unused top-up credit is a 32-bit column of micro-USD; this keeps it well inside it. */
const MAX_TOP_UP_BALANCE_MICROS = 2_000_000_000;

/** Admin side of the venues' AI credit: switch, monthly override, end of trial and manual top-ups. */
@Injectable()
export class AiAdminCreditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: VenueAiCreditService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async list(q?: string) {
    const term = q?.trim();
    const venues = await this.prisma.venue.findMany({
      where: term
        ? {
            OR: [
              { nameEn: { contains: term, mode: 'insensitive' } },
              { nameAr: { contains: term, mode: 'insensitive' } },
              { owner: { name: { contains: term, mode: 'insensitive' } } },
            ],
          }
        : {},
      select: {
        id: true,
        nameEn: true,
        nameAr: true,
        ownerId: true,
        owner: { select: { name: true } },
      },
      // Every venue: the counts above the table and its order (highest real cost first) need them all.
      orderBy: { createdAt: 'asc' },
    });
    const ids = venues.map((v) => v.id);
    const subs = new Map(
      (
        await this.prisma.venueSubscription.findMany({
          where: { venueId: { in: ids } },
          select: CREDIT_ROW_SELECT,
        })
      ).map((s) => [s.venueId, s]),
    );
    for (const v of venues)
      if (!subs.has(v.id))
        subs.set(v.id, await this.subscriptions.ensure(v.id));
    const now = new Date();
    const views = await this.credit.views(
      venues.map((v) => ({ ...subs.get(v.id)!, ownerId: v.ownerId })),
      now,
    );
    const spent = await this.realCost(
      ids,
      new Date(now.getTime() - CREDIT_WINDOW_DAYS * DAY_MS),
    );
    const items = venues
      .map((v, i) => ({
        venueId: v.id,
        venueNameEn: v.nameEn,
        venueNameAr: v.nameAr,
        ownerName: v.owner.name,
        planKey: subs.get(v.id)!.planKey,
        overrideUsd: subs.get(v.id)!.aiCreditOverrideUsd,
        realCost30dUsd: fromMicros(spent.get(v.id) ?? 0),
        ...publicView(views[i]),
      }))
      .sort(
        (a, b) =>
          b.realCost30dUsd - a.realCost30dUsd || a.balanceUsd - b.balanceUsd,
      );
    return {
      counts: {
        venues: items.length,
        off: items.filter((i) => !i.enabled).length,
        empty: items.filter((i) => i.enabled && i.balanceUsd <= 0).length,
        paused: items.filter((i) => i.paused).length,
        trial: items.filter((i) => i.trial).length,
      },
      items,
    };
  }

  async detail(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, nameEn: true, nameAr: true, currency: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    const view = await this.credit.state(venueId);
    const sub = await this.subscriptions.ensure(venueId);
    const since = view.trial
      ? sub.startedAt
      : (view.cycleStartedAt ?? sub.startedAt);
    const [topUps, spent] = await Promise.all([
      this.prisma.aiCreditTopUp.findMany({
        where: { venueId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { recordedBy: { select: { name: true } } },
      }),
      this.realCost([venueId], since),
    ]);
    return {
      venueId,
      venueNameEn: venue.nameEn,
      venueNameAr: venue.nameAr,
      currency: sub.currency,
      planKey: sub.planKey,
      planUsd: this.credit.planUsd(sub.planKey),
      trialUsd: this.credit.trialUsd(),
      overrideUsd: sub.aiCreditOverrideUsd,
      subscriptionState: subscriptionStanding(sub).state,
      ...publicView(view),
      /** Real provider cost logged for this venue since the window (or the trial) started. */
      realCostUsd: fromMicros(spent.get(venueId) ?? 0),
      realCostSince: since,
      topUps: topUps.map((t) => ({
        id: t.id,
        receivedAmount: t.receivedAmount,
        receivedCurrency: t.receivedCurrency,
        creditedUsd: fromMicros(t.creditedMicros),
        note: t.note,
        recordedBy: t.recordedBy.name,
        createdAt: t.createdAt,
      })),
    };
  }

  async update(adminId: string, venueId: string, dto: UpdateVenueCreditDto) {
    const sub = await this.subscriptions.ensure(venueId);
    const data: Prisma.VenueSubscriptionUpdateInput = {};
    const changed: Record<string, unknown> = {};
    if (dto.enabled !== undefined && dto.enabled !== sub.aiAssistantEnabled) {
      data.aiAssistantEnabled = dto.enabled;
      changed.enabled = dto.enabled;
    }
    if (
      dto.overrideUsd !== undefined &&
      dto.overrideUsd !== sub.aiCreditOverrideUsd
    ) {
      data.aiCreditOverrideUsd = dto.overrideUsd;
      changed.overrideUsd = {
        from: sub.aiCreditOverrideUsd,
        to: dto.overrideUsd,
      };
    }
    if (dto.endTrial && sub.aiTrial) {
      Object.assign(data, freshAiCycle());
      changed.endTrial = true;
    }
    if (Object.keys(changed).length) {
      await this.prisma.$transaction([
        this.prisma.venueSubscription.update({ where: { id: sub.id }, data }),
        this.prisma.auditLogEntry.create({
          data: {
            actorUserId: adminId,
            action: 'ai.credit.update',
            targetType: 'venue',
            targetId: venueId,
            metadata: { venueId, changed } as Prisma.InputJsonValue,
          },
        }),
      ]);
    }
    return this.detail(venueId);
  }

  async topUp(adminId: string, venueId: string, dto: AiCreditTopUpDto) {
    const sub = await this.subscriptions.ensure(venueId);
    const creditedMicros = toMicros(dto.creditedUsd);
    if (sub.aiTopUpMicros + creditedMicros > MAX_TOP_UP_BALANCE_MICROS)
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'AI_CREDIT_TOP_UP_TOO_LARGE',
        `Unused top-up credit cannot go above ${fromMicros(MAX_TOP_UP_BALANCE_MICROS)} USD`,
      );
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.aiCreditTopUp.create({
        data: {
          subscriptionId: sub.id,
          venueId,
          receivedAmount: dto.receivedAmount,
          receivedCurrency: dto.receivedCurrency,
          creditedMicros,
          note: dto.note?.trim() || null,
          recordedById: adminId,
        },
      });
      await tx.venueSubscription.update({
        where: { id: sub.id },
        data: { aiTopUpMicros: { increment: creditedMicros } },
      });
      // The amount received stays in the top-up row; the audit trail only names what was credited.
      await tx.auditLogEntry.create({
        data: {
          actorUserId: adminId,
          action: 'ai.credit.top_up',
          targetType: 'venue',
          targetId: venueId,
          metadata: { venueId, topUpId: row.id, creditedUsd: dto.creditedUsd },
        },
      });
    });
    return this.detail(venueId);
  }

  private async realCost(
    venueIds: string[],
    since: Date,
  ): Promise<Map<string, number>> {
    if (!venueIds.length) return new Map();
    const rows = await this.prisma.aiOwnerEventLog.groupBy({
      by: ['venueId'],
      where: { venueId: { in: venueIds }, createdAt: { gte: since } },
      _sum: { costMicros: true },
    });
    return new Map(rows.map((r) => [r.venueId ?? '', r._sum.costMicros ?? 0]));
  }
}

function publicView(v: VenueAiCreditView) {
  const { roomMicros: _room, venueId: _venue, ...rest } = v;
  return rest;
}
