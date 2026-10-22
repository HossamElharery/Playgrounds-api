import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CamoHost, ModerationEvent } from './camo-host';
import { countedReports, ladder, type ReportRow } from './camo-sanctions';
import { CamoSettingsService } from './camo-settings.service';

export const REPORT_REASONS = ['voice_noise', 'abuse', 'offensive_name', 'cheating', 'griefing', 'harassment', 'child_safety', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

const AVOID_HOURS = 24;

/** Persists what the host reports (audit, votes, avoid lists), takes reports, runs the sanction ladder, backs the admin tab. */
@Injectable()
export class CamoModerationService {
  private readonly logger = new Logger(CamoModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CamoSettingsService,
  ) {}

  /** Host hook: fire and forget, a failed write never stops a match. */
  record(e: ModerationEvent): void {
    void this.write(e).catch((err) => this.logger.warn(`moderation write failed: ${err instanceof Error ? err.message : err}`));
  }

  private async write(e: ModerationEvent): Promise<void> {
    if (e.type === 'vote.start') {
      await this.prisma.camoModerationAudit.create({ data: { actorId: e.by, action: `vote.start.${e.kind}`, targetUserId: e.target, details: { matchId: e.matchId, voteId: e.voteId } } });
    } else if (e.type === 'vote.end') {
      await this.prisma.camoVote.create({ data: { matchId: e.matchId, kind: e.kind, targetUserId: e.target, startedBy: e.by, votes: { yes: e.yes }, result: e.passed ? 'passed' : 'failed' } });
      await this.prisma.camoModerationAudit.create({ data: { actorId: 'system', action: `vote.end.${e.kind}.${e.passed ? 'passed' : 'failed'}`, targetUserId: e.target, details: { matchId: e.matchId, by: e.by, yes: e.yes } } });
      // a failed vote is also a signal: someone who starts many of them shows up in the audit
    } else if (e.type === 'mute') {
      await this.prisma.camoModerationAudit.create({ data: { actorId: e.by === 'vote' ? 'system' : e.by, action: e.by === 'vote' ? 'mute.vote' : 'mute.host', targetUserId: e.target, details: { matchId: e.matchId } } });
    } else if (e.type === 'kick') {
      await this.prisma.camoModerationAudit.create({ data: { actorId: e.by === 'vote' ? 'system' : e.by, action: e.by === 'vote' ? 'kick.vote' : e.ban ? 'ban.room' : 'kick.room', targetUserId: e.target, details: { matchId: e.matchId, voters: e.voters } } });
      if (e.by === 'vote') {
        // the matchmaker keeps them apart for a day, both ways
        const until = new Date(Date.now() + AVOID_HOURS * 3_600_000);
        for (const voter of e.voters) {
          await this.prisma.camoMatchmakingAvoid.upsert({ where: { userId_avoidUserId: { userId: voter, avoidUserId: e.target } }, create: { userId: voter, avoidUserId: e.target, until }, update: { until } });
        }
      }
    }
  }

  // ── reports ───────────────────────────────────────────────────────────────

  async report(host: CamoHost, reporterId: string, input: { eid: string; reason: string; note?: string }): Promise<{ ok: boolean; reason?: string }> {
    if (!REPORT_REASONS.includes(input.reason as ReportReason)) return { ok: false, reason: 'bad_reason' };
    const cfg = this.settings.current;
    const hourAgo = new Date(Date.now() - 3_600_000);
    const recent = await this.prisma.camoReport.count({ where: { reporterId, createdAt: { gt: hourAgo } } });
    if (recent >= cfg.reportsPerHour) return { ok: false, reason: 'rate' };
    const target = host.userOfEid(reporterId, input.eid);
    if (!target || target.userId === reporterId) return { ok: false, reason: 'unknown' };
    const context = host.reportContext(reporterId) ?? { matchId: '', round: 0, phase: '', log: [] };
    const priorForTarget = await this.prisma.camoReport.count({ where: { targetUserId: target.userId } });
    const row = await this.prisma.camoReport.create({
      data: {
        // the match row only exists once the match ends, so a live report keeps the id inside its context
        matchId: null,
        reporterId,
        targetUserId: target.userId,
        round: context.round,
        reason: input.reason,
        note: input.note?.slice(0, 300) ?? null,
        context: JSON.parse(JSON.stringify({ matchId: context.matchId, phase: context.phase, log: context.log, priorReports: priorForTarget, reporterParty: host.partyOf(reporterId) })),
      },
    });
    await this.applyLadder(target.userId, row.id).catch((err) => this.logger.warn(`ladder failed: ${err instanceof Error ? err.message : err}`));
    return { ok: true };
  }

  private async applyLadder(targetUserId: string, newReportId: string): Promise<void> {
    const cfg = this.settings.current;
    const from = new Date(Date.now() - cfg.reportWindowHours * 3_600_000);
    const rows = await this.prisma.camoReport.findMany({ where: { targetUserId, createdAt: { gte: from } }, select: { id: true, reporterId: true, matchId: true, reason: true, createdAt: true, context: true } });
    const asRows: ReportRow[] = rows.map((r) => ({ id: r.id, reporterId: r.reporterId, matchId: ((r.context as { matchId?: string } | null)?.matchId ?? r.matchId) as string | null, partyKey: ((r.context as { reporterParty?: string | null } | null)?.reporterParty ?? null) as string | null, reason: r.reason, createdAt: r.createdAt.getTime() }));
    const counted = countedReports(asRows, Date.now(), cfg);
    await this.prisma.camoReport.updateMany({ where: { id: { in: counted.map((c) => c.id) } }, data: { counted: true } });
    const prior = await this.prisma.camoSanction.findMany({ where: { userId: targetUserId, kind: 'voice_restrict' }, select: { createdAt: true } });
    const active = await this.prisma.camoSanction.findMany({ where: { userId: targetUserId, OR: [{ until: null }, { until: { gt: new Date() } }] }, select: { kind: true } });
    const have = new Set(active.map((a) => a.kind));
    for (const action of ladder(counted, prior.map((p) => p.createdAt.getTime()), Date.now(), cfg)) {
      if (action.kind === 'none' || have.has(action.kind)) continue;
      const until = action.kind === 'voice_restrict' ? new Date(Date.now() + action.hours * 3_600_000) : action.kind === 'warn' ? new Date(Date.now() + 7 * 86_400_000) : null;
      const device = await this.prisma.user.findUnique({ where: { id: targetUserId }, select: { isGuest: true } });
      await this.prisma.camoSanction.create({ data: { userId: targetUserId, kind: action.kind, until, source: 'auto', reportIds: counted.map((c) => c.id) } });
      await this.prisma.camoModerationAudit.create({ data: { actorId: 'system', action: `sanction.${action.kind}`, targetUserId, details: { reports: counted.length, guest: !!device?.isGuest, trigger: newReportId } } });
    }
  }

  /** What the user must be told at their next match, and whether their mic is restricted. */
  async notices(userId: string): Promise<{ warn: boolean; voiceRestrictedUntil: number | null; nameHidden: boolean }> {
    const now = new Date();
    const rows = await this.prisma.camoSanction.findMany({ where: { userId, OR: [{ until: null }, { until: { gt: now } }] }, select: { kind: true, until: true } });
    const restrict = rows.find((r) => r.kind === 'voice_restrict');
    return { warn: rows.some((r) => r.kind === 'warn'), voiceRestrictedUntil: restrict?.until?.getTime() ?? null, nameHidden: rows.some((r) => r.kind === 'name_hidden') };
  }

  /** «Block» from the player sheet: the same block list as the rest of Matchena, so the matchmaker and the squads honour it. */
  async blockSeat(host: CamoHost, viewerId: string, eid: string): Promise<{ ok: boolean }> {
    const target = host.userOfEid(viewerId, eid);
    if (!target || target.userId === viewerId) return { ok: false };
    await this.prisma.$transaction([
      this.prisma.userBlock.upsert({ where: { blockerId_blockedId: { blockerId: viewerId, blockedId: target.userId } }, update: {}, create: { blockerId: viewerId, blockedId: target.userId } }),
      this.prisma.friendship.deleteMany({ where: { OR: [{ requesterId: viewerId, addresseeId: target.userId }, { requesterId: target.userId, addresseeId: viewerId }] } }),
    ]);
    return { ok: true };
  }

  // ── admin tab ─────────────────────────────────────────────────────────────

  async queue(status: 'open' | 'done' = 'open', take = 50) {
    const rows = await this.prisma.camoReport.findMany({
      where: { status },
      orderBy: [{ counted: 'desc' }, { createdAt: 'desc' }],
      take,
      select: { id: true, matchId: true, round: true, reason: true, note: true, context: true, counted: true, status: true, createdAt: true, targetUserId: true, reporterId: true, target: { select: { name: true, isGuest: true } } },
    });
    const ids = [...new Set(rows.map((r) => r.targetUserId).filter((x): x is string => !!x))];
    const totals = await this.prisma.camoReport.groupBy({ by: ['targetUserId'], where: { targetUserId: { in: ids } }, _count: { _all: true } });
    const count = new Map(totals.map((t) => [t.targetUserId, t._count._all]));
    return rows.map((r) => ({ ...r, targetReports: count.get(r.targetUserId) ?? 0 }));
  }

  async act(adminId: string, reportId: string, action: 'ignore' | 'warn' | 'voice_restrict' | 'force_rename' | 'camo_ban', hours?: number | null) {
    const report = await this.prisma.camoReport.findUnique({ where: { id: reportId }, select: { targetUserId: true } });
    if (!report) return { ok: false, reason: 'unknown' };
    const userId = report.targetUserId;
    if (action !== 'ignore' && userId) {
      const kind = action === 'force_rename' ? 'name_hidden' : action;
      const until = action === 'camo_ban' || action === 'force_rename' ? (hours ? new Date(Date.now() + hours * 3_600_000) : null) : new Date(Date.now() + (hours ?? 24) * 3_600_000);
      await this.prisma.camoSanction.create({ data: { userId, kind, until, source: 'admin', reportIds: [reportId] } });
    }
    await this.prisma.camoReport.update({ where: { id: reportId }, data: { status: 'done' } });
    await this.prisma.camoModerationAudit.create({ data: { actorId: adminId, action: `report.${action}`, targetUserId: userId, details: { reportId, hours: hours ?? null } } });
    return { ok: true };
  }

  async audit(take = 100) {
    return this.prisma.camoModerationAudit.findMany({ orderBy: { createdAt: 'desc' }, take });
  }

  async logAdmin(adminId: string, action: string, targetUserId: string | null, details: Record<string, unknown>): Promise<void> {
    await this.prisma.camoModerationAudit.create({ data: { actorId: adminId, action, targetUserId, details: details as object } });
  }
}
