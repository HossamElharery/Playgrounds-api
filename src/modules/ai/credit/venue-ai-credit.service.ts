import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiSettingsService } from '../ai-settings.service';
import { toMicros } from '../ai-day';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { assertVenueAccess } from '../../../common/access/owner-access';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import {
  CREDIT_ROW_SELECT,
  creditView,
  dueWindow,
  ownerCreditDto,
  planCreditSetting,
  type CreditRow,
  type VenueAiCreditView,
} from './venue-ai-credit';

export type CreditVerdict =
  | { ok: true; view: VenueAiCreditView }
  | { ok: false; reason: 'disabled' | 'exhausted'; view: VenueAiCreditView };

/**
 * The per-venue gate in front of the owner assistant. It only ever decides whether the
 * assistant may call a model: bookings, payments, staff and reports never read it.
 */
@Injectable()
export class VenueAiCreditService {
  private readonly logger = new Logger(VenueAiCreditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AiSettingsService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  planUsd(planKey: string): number {
    return this.settings.number(planCreditSetting(planKey)) ?? 0;
  }

  trialUsd(): number {
    return this.settings.number('creditTrialUsd') ?? 0;
  }

  /** The venue's credit now, rolling a window that ran out over first. */
  async state(
    venueId: string,
    now: Date = new Date(),
  ): Promise<VenueAiCreditView> {
    let row = await this.row(venueId);
    const due = dueWindow(row, now);
    if (due) {
      const rolled = await this.prisma.venueSubscription.updateMany({
        where: { venueId, aiTrial: false, aiCycleEndsAt: row.aiCycleEndsAt },
        data: {
          aiCycleStartedAt: due.start,
          aiCycleEndsAt: due.end,
          aiCycleSpentMicros: 0,
        },
      });
      // Someone else rolled it (or an admin renewed it) in between: read what they wrote.
      row = rolled.count
        ? {
            ...row,
            aiCycleStartedAt: due.start,
            aiCycleEndsAt: due.end,
            aiCycleSpentMicros: 0,
          }
        : await this.row(venueId);
    }
    return this.view(row, now);
  }

  async check(venueId: string, now: Date = new Date()): Promise<CreditVerdict> {
    const view = await this.state(venueId, now);
    if (!view.enabled) return { ok: false, reason: 'disabled', view };
    if (view.balanceUsd <= 0) return { ok: false, reason: 'exhausted', view };
    return { ok: true, view };
  }

  /**
   * Charges a model call's real cost: the window's allowance first, then top-up credit.
   * One atomic statement, so concurrent calls from the owner and staff add up correctly.
   */
  async charge(
    venueId: string,
    view: Pick<VenueAiCreditView, 'roomMicros'>,
    costUsd: number,
  ): Promise<void> {
    const cost = toMicros(costUsd);
    if (!cost) return;
    const room = Math.max(0, view.roomMicros);
    try {
      await this.prisma.$executeRaw`
        UPDATE "VenueSubscription" SET
          "aiCycleSpentMicros" = LEAST(GREATEST(${room}::int, "aiCycleSpentMicros"), "aiCycleSpentMicros" + ${cost}::int),
          "aiTopUpMicros" = GREATEST(0, "aiTopUpMicros" - GREATEST(0, "aiCycleSpentMicros" + ${cost}::int - GREATEST(${room}::int, "aiCycleSpentMicros")))
        WHERE "venueId" = ${venueId}`;
    } catch (err) {
      this.logger.warn(
        `[ai-credit] could not charge ${costUsd} USD to venue ${venueId}: ${String(err)}`,
      );
    }
  }

  /** The balance for the assistant's own screen; the top-up history is for the owner only. */
  async forOwner(user: AuthenticatedUser, venueId: string) {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const view = await this.state(venueId);
    const owner = user.roles.includes('owner') || user.roles.includes('admin');
    const topUps = owner
      ? await this.prisma.aiCreditTopUp.findMany({
          where: { venueId },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { id: true, creditedMicros: true, createdAt: true },
        })
      : null;
    return ownerCreditDto(view, topUps);
  }

  /** Views for many venues at once, without writing (for the admin list). */
  async views(
    rows: (CreditRow & { ownerId: string })[],
    now: Date = new Date(),
  ): Promise<VenueAiCreditView[]> {
    const trialOwners = [
      ...new Set(rows.filter(pooledTrial).map((r) => r.ownerId)),
    ];
    const spentByVenue = new Map<string, { ownerId: string; micros: number }>();
    if (trialOwners.length) {
      const pooled = await this.prisma.venueSubscription.findMany({
        where: {
          aiTrial: true,
          aiCreditOverrideUsd: null,
          venue: { ownerId: { in: trialOwners } },
        },
        select: {
          venueId: true,
          aiCycleSpentMicros: true,
          venue: { select: { ownerId: true } },
        },
      });
      for (const p of pooled)
        spentByVenue.set(p.venueId, {
          ownerId: p.venue.ownerId,
          micros: p.aiCycleSpentMicros,
        });
    }
    return rows.map((row) => {
      let others = 0;
      if (pooledTrial(row)) {
        for (const [venueId, s] of spentByVenue)
          if (venueId !== row.venueId && s.ownerId === row.ownerId)
            others += s.micros;
      }
      return creditView(
        row,
        {
          planUsd: this.planUsd(row.planKey),
          trialUsd: this.trialUsd(),
          otherTrialSpentMicros: others,
        },
        now,
      );
    });
  }

  private async view(row: CreditRow, now: Date): Promise<VenueAiCreditView> {
    return creditView(
      row,
      {
        planUsd: this.planUsd(row.planKey),
        trialUsd: this.trialUsd(),
        otherTrialSpentMicros: pooledTrial(row)
          ? await this.otherTrialSpent(row.venueId)
          : 0,
      },
      now,
    );
  }

  /** One trial credit per owner: what their other venues still on the trial credit have used. */
  private async otherTrialSpent(venueId: string): Promise<number> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { ownerId: true },
    });
    if (!venue) return 0;
    const sum = await this.prisma.venueSubscription.aggregate({
      _sum: { aiCycleSpentMicros: true },
      where: {
        aiTrial: true,
        aiCreditOverrideUsd: null,
        venueId: { not: venueId },
        venue: { ownerId: venue.ownerId },
      },
    });
    return sum._sum.aiCycleSpentMicros ?? 0;
  }

  private async row(venueId: string): Promise<CreditRow> {
    const row = await this.prisma.venueSubscription.findUnique({
      where: { venueId },
      select: CREDIT_ROW_SELECT,
    });
    return row ?? (await this.subscriptions.ensure(venueId));
  }
}

function pooledTrial(
  row: Pick<CreditRow, 'aiTrial' | 'aiCreditOverrideUsd'>,
): boolean {
  return row.aiTrial && row.aiCreditOverrideUsd == null;
}
