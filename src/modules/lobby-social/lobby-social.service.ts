import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import { applySocialCommand, createSocialState, SocialRuleError, socialSnapshot, tickSocialState, socialConnected } from './social.engine';
import { SOCIAL_QUESTIONS } from './social.questions';
import { Exposure, SocialCommand, SocialSnapshot, SocialState } from './social.types';
import { SocialContentService } from './social-content.controller';

type Tx = Prisma.TransactionClient;
@Injectable()
export class LobbySocialService {
  private readonly logger = new Logger(LobbySocialService.name);
  publish: ((squadId: string, snapshots: Map<string, SocialSnapshot>) => void) | null = null;
  private sweeping = false;
  private readonly lastPublished = new Map<string, string>();
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService,
    @Optional() private readonly presence?: PresenceService,
    @Optional() private readonly content?: SocialContentService) {}

  enabled(): boolean { return this.config.get<string>('LOBBY_SOCIAL_ENABLED') === 'true'; }
  private async bank() {
    const localDrafts = this.config.get<string>('NODE_ENV') !== 'production' &&
      this.config.get<string>('LOBBY_SOCIAL_ALLOW_DRAFT_CONTENT') === 'true';
    const questions=this.content?await this.content.list():SOCIAL_QUESTIONS;
    return questions.filter(q => q.status === 'published' || localDrafts);
  }

  async snapshot(squadId: string, userId: string): Promise<SocialSnapshot> {
    if (!this.enabled()) return socialSnapshot(null, squadId, userId, Date.now(), false);
    return this.run(squadId, userId, async (tx, s, now) => {
      if (s) {
        const me = s.members.find(m => m.userId === userId);
        if (me) { me.lastSeen = now; me.disconnectedAt = null; }
        if (tickSocialState(s, now)) s.revision++;
        await this.expose(tx, s);
      }
      return s;
    });
  }

  async command(userId: string, cmd: SocialCommand): Promise<SocialSnapshot> {
    if (!this.enabled()) throw new SocialRuleError('disabled');
    return this.run(cmd.squadId, userId, async (tx, s, now) => {
      const key = `${userId}:${cmd.requestId}`;
      if (s?.receipts.some(r => r.key === key)) return s;
      if (cmd.action === 'create') {
        if (s && s.phase !== 'ended') return s;
        if (s && cmd.sessionId !== s.id) throw new SocialRuleError('stale');
        s = createSocialState(cmd.squadId, userId, cmd, now);
      } else {
        if (!s || cmd.sessionId !== s.id) throw new SocialRuleError('stale');
        if (cmd.action !== 'pulse' && cmd.action !== 'seen') {
          if (tickSocialState(s, now)) s.revision++;
          if (cmd.expectedVersion !== s.revision) throw new SocialRuleError('stale');
        }
        if (cmd.action === 'switch' || cmd.action === 'restart') {
          if (s.hostId !== userId) throw new SocialRuleError('not_allowed');
          if (cmd.action === 'switch') {
            if (!s.proposedGame || !['preparing', 'between_rounds', 'paused_insufficient_players', 'no_eligible_content', 'discussion'].includes(s.phase)) throw new SocialRuleError('not_allowed');
            const confirmed = s.members.filter(m => s!.confirmedIds.includes(m.userId) && socialConnected(m, now));
            if (confirmed.length < 2 || !s.confirmedIds.includes(userId)) throw new SocialRuleError('need_players');
            const previous = s;
            s = createSocialState(cmd.squadId, userId, { ...cmd, game: previous.proposedGame!, mode: 'light', replayAllowed: false }, now);
            s.members = previous.members.map(m => ({ ...m, role: previous.confirmedIds.includes(m.userId) ? 'player' : 'listener', turns: 0, cycleTurns: 0, targets: 0, eligibleFromRound: 0 }));
          } else {
            if (s.phase !== 'ended' && s.phase !== 'no_eligible_content') throw new SocialRuleError('not_allowed');
            s = createSocialState(cmd.squadId, userId, { ...cmd, game: s.game, mode: s.mode, consent: s.mode === 'closer' }, now);
          }
        } else if (cmd.action === 'seen') {
          if ((s.phase !== 'answering' && !(s.cardRound && s.phase === 'discussion')) || s.roundId !== cmd.roundId || s.question?.id !== cmd.questionId) throw new SocialRuleError('stale');
          await this.expose(tx, s, [userId]);
        } else {
          const ids = s.members.map(m => m.userId);
          if (!ids.includes(userId)) ids.push(userId);
          const history = cmd.action === 'target' || cmd.action === 'skip' ?
            await tx.$queryRaw<Exposure[]>(Prisma.sql`SELECT "userId", "familyId", COUNT(*)::int AS count FROM "LobbySocialExposure" WHERE "userId" IN (${Prisma.join(ids)}) GROUP BY "userId", "familyId"`) : [];
          applySocialCommand(s, userId, cmd, await this.bank(), history, now);
          if (cmd.action !== 'pulse') s.revision++;
        }
      }
      if (cmd.action !== 'pulse' && cmd.action !== 'seen') {
        s.receipts = s.receipts.filter(r => now - r.at < 3_600_000).slice(-255);
        s.receipts.push({ key, at: now });
      }
      await this.expose(tx, s);
      return s;
    });
  }

  private async run(squadId: string, userId: string | null, mutate: (tx: Tx, s: SocialState | null, now: number) => Promise<SocialState | null>): Promise<SocialSnapshot> {
    const result = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`social:${squadId}`}))`;
      if (userId) {
        const membership = await tx.squadMember.findUnique({ where: { squadId_userId: { squadId, userId } }, select: { id: true } });
        if (!membership) throw new SocialRuleError('not_in_room');
      }
      const rows = await tx.$queryRaw<{ state: SocialState }[]>`SELECT "state" FROM "LobbySocialState" WHERE "squadId" = ${squadId}`;
      const now = Date.now();
      const previous = rows[0] ? JSON.stringify(rows[0].state) : null;
      const state = await mutate(tx, rows[0]?.state ?? null, now);
      if (state && JSON.stringify(state) !== previous) {
        await tx.$executeRaw`INSERT INTO "LobbySocialState" ("squadId", "state", "updatedAt") VALUES (${squadId}, ${JSON.stringify(state)}::jsonb, NOW()) ON CONFLICT ("squadId") DO UPDATE SET "state" = EXCLUDED."state", "updatedAt" = NOW()`;
      }
      return { state, now };
    }, { timeout: 10_000 });
    const recipients = result.state?.members.map(m => m.userId) ?? [];
    const snapshots = new Map(recipients.map(id => [id, socialSnapshot(result.state, squadId, id, result.now)]));
    // Empty-user projection is safe for all room members, including nonparticipants.
    snapshots.set('', socialSnapshot(result.state, squadId, '', result.now));
    const fingerprint = JSON.stringify([...snapshots].map(([id, snapshot]) => [id, snapshot.session, snapshot.personal]));
    if (this.lastPublished.get(squadId) !== fingerprint) {
      this.lastPublished.set(squadId, fingerprint);
      this.publish?.(squadId, snapshots);
    }
    if (result.state?.phase === 'ended') this.lastPublished.delete(squadId);
    if (this.lastPublished.size > 2000) this.lastPublished.delete(this.lastPublished.keys().next().value!);
    return socialSnapshot(result.state, squadId, userId ?? '', result.now);
  }

  private async expose(tx: Tx, s: SocialState, viewerIds?: string[]): Promise<void> {
    if ((s.phase !== 'answering' && !(s.cardRound && s.phase === 'discussion')) || !s.question || !s.roundId) return;
    s.exposedUsers ??= [];
    for (const id of viewerIds ?? s.members.filter(m => m.viewing && socialConnected(m, Date.now())).map(m => m.userId)) {
      if (s.exposedUsers.includes(id)) continue;
      await tx.$executeRaw`INSERT INTO "LobbySocialExposure" ("userId", "roundId", "sessionId", "questionId", "familyId") VALUES (${id}, ${s.roundId}, ${s.id}, ${s.question.id}, ${s.question.familyId}) ON CONFLICT ("userId", "roundId") DO NOTHING`;
      s.exposedUsers.push(id);
    }
  }

  async connectionChanged(userId: string, online: boolean): Promise<void> {
    if (!this.enabled()) return;
    const rows = await this.prisma.$queryRaw<{squadId: string}[]>`SELECT "squadId" FROM "SquadMember" WHERE "userId" = ${userId}`;
    for (const {squadId} of rows) await this.run(squadId, null, async (_tx, s, now) => {
      const m = s?.members.find(m => m.userId === userId);
      if (m && s && s.phase !== 'ended') {
        m.disconnectedAt = online ? null : now; m.lastSeen = now; s.revision++;
      }
      return s;
    });
  }

  async memberLeft(squadId: string, userId: string): Promise<void> {
    if (!this.enabled()) return;
    await this.run(squadId, null, async (tx, s, now) => {
      if (!s || s.phase === 'ended') return s;
      const m = s.members.find(p => p.userId === userId);
      if (m) {
        m.lastSeen = now;
        applySocialCommand(s, userId, { squadId, requestId: 'membership-ended', action: 'leave' }, [], [], now);
        s.revision++;
      }
      return s;
    });
  }

  @Interval(500)
  async sweep(): Promise<void> {
    if (!this.enabled() || this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = await this.prisma.$queryRaw<{ squadId: string }[]>`SELECT "squadId" FROM "LobbySocialState" WHERE "state"->>'phase' <> 'ended'`;
      for (const row of rows) await this.run(row.squadId, null, async (tx, s, now) => {
        // Read the established app presence tracker. Never touch its connection/media lifecycle.
        if (s && this.presence) for (const m of s.members) {
          if (m.disconnectedAt == null && this.presence.isOnline(m.userId) && now - m.lastSeen > 5000) {
            m.lastSeen = now;
          }
        }
        if (s && tickSocialState(s, now)) s.revision++;
        if (s) await this.expose(tx, s);
        return s;
      });
    } catch {
      // Never log state, commands, choices or database errors containing JSON.
      this.logger.warn('Social game timer unavailable; awaiting database recovery');
    } finally { this.sweeping = false; }
  }
}
