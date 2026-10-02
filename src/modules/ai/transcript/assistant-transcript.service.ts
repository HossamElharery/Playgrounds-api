import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, type AssistantSender } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { buildPagination } from '../../../common/dto/page-query.dto';
import { flagsFor, TRANSCRIPT_FLAGS, type FlagInput, type TranscriptFlag, type TranscriptOutcome } from './transcript-flags';

export interface TurnInput {
  ownerId: string;
  ownerName?: string | null;
  venueId?: string | null;
  /** The owner's sentence as sent. */
  ownerText: string;
  /** What the assistant said back (Arabic first), if anything. */
  replyText?: string;
  intent?: string;
  outcome: TranscriptOutcome;
  confidence?: number;
  model?: string | null;
  blockingCode?: string;
  /** What was proposed, so the admin can see the money and the customer involved. */
  meta?: Record<string, unknown>;
}

export interface EventInput {
  ownerId: string;
  ownerName?: string | null;
  venueId?: string | null;
  kind: 'action' | 'undo';
  text: string;
  outcome: TranscriptOutcome;
  intent?: string;
  meta?: Record<string, unknown>;
}

export interface MirrorInput {
  ownerId: string;
  ownerName?: string | null;
  venueId: string;
  sender: AssistantSender;
  text: string;
  scheduleChange?: boolean;
}

export interface TranscriptFilters {
  ownerId?: string;
  venueId?: string;
  q?: string;
  flag?: TranscriptFlag;
  /** Only lines with at least one flag. */
  notable?: boolean;
  outcome?: string;
  sender?: AssistantSender;
  from?: string;
  to?: string;
  page: number;
  perPage: number;
}

type Row = Prisma.AssistantTranscriptGetPayload<object>;

const NAME_TTL_MS = 10 * 60_000;
const REPEAT_WINDOW_MS = 10 * 60_000;
/** A server-written line absorbs the app's own copy of it only if that copy arrives this soon. */
const MIRROR_WINDOW_MS = 3 * 60_000;

function present(r: Row) {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    ownerId: r.ownerId,
    ownerName: r.ownerName,
    venueId: r.venueId,
    venueName: r.venueName,
    sender: r.sender,
    kind: r.kind,
    text: r.text,
    intent: r.intent,
    outcome: r.outcome,
    confidence: r.confidence,
    model: r.model,
    flags: r.flags,
    meta: r.meta,
    source: r.source,
  };
}

/**
 * The permanent record of every owner ↔ assistant exchange, kept by the server.
 * The app also stores a copy for the owner's own chat window, but that copy is
 * posted by the browser (it can fail) and lives under the venue (it goes when
 * the venue does). This one is written where the exchange happens, and nothing
 * deletes it. Writes never delay or fail the owner's request.
 */
@Injectable()
export class AssistantTranscriptService {
  private readonly logger = new Logger(AssistantTranscriptService.name);
  private readonly names = new Map<string, { value: string | null; exp: number }>();

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  // ------------------------------------------------------------ writing ----

  /** One sentence from the owner and what the assistant answered. */
  async recordTurn(turn: TurnInput): Promise<void> {
    if (!this.prisma) return;
    try {
      const text = turn.ownerText.trim().slice(0, 600);
      if (!text) return;
      const venueName = await this.venueName(turn.venueId);
      const recentSame = await this.prisma.assistantTranscript.count({
        where: {
          ownerId: turn.ownerId,
          sender: 'owner',
          kind: 'chat',
          text,
          createdAt: { gte: new Date(Date.now() - REPEAT_WINDOW_MS) },
        },
      });
      const flagInput: FlagInput = {
        text,
        intent: turn.intent,
        outcome: turn.outcome,
        confidence: turn.confidence,
        blockingCode: turn.blockingCode,
        recentSame,
      };
      const flags = flagsFor(flagInput);
      const base = {
        ownerId: turn.ownerId,
        ownerName: turn.ownerName ?? null,
        venueId: turn.venueId ?? null,
        venueName,
        kind: 'chat',
        intent: turn.intent?.slice(0, 40) ?? null,
        outcome: turn.outcome,
        confidence: typeof turn.confidence === 'number' && Number.isFinite(turn.confidence) ? turn.confidence : null,
        model: turn.model?.slice(0, 120) ?? null,
        flags,
        source: 'server',
      };
      const now = Date.now();
      await this.prisma.assistantTranscript.create({ data: { ...base, sender: 'owner', text, createdAt: new Date(now) } });
      const reply = turn.replyText?.trim().slice(0, 1500);
      if (reply) {
        await this.prisma.assistantTranscript.create({
          data: {
            ...base,
            sender: 'assistant',
            text: reply,
            meta: turn.meta ? (turn.meta as Prisma.InputJsonValue) : undefined,
            // A hair later, so the pair always reads owner-then-assistant.
            createdAt: new Date(now + 1),
          },
        });
      }
    } catch (err) {
      this.logger.warn(`could not record a turn: ${String(err)}`);
    }
  }

  /** What the assistant did after the owner pressed Confirm, or took back with Undo. */
  async recordEvent(event: EventInput): Promise<void> {
    if (!this.prisma) return;
    try {
      const flags: TranscriptFlag[] = event.outcome === 'failed' || event.outcome === 'error' ? ['failed'] : [];
      await this.prisma.assistantTranscript.create({
        data: {
          ownerId: event.ownerId,
          ownerName: event.ownerName ?? null,
          venueId: event.venueId ?? null,
          venueName: await this.venueName(event.venueId),
          sender: 'assistant',
          kind: event.kind,
          text: event.text.trim().slice(0, 1500) || '—',
          intent: event.intent?.slice(0, 40) ?? null,
          outcome: event.outcome,
          flags,
          meta: event.meta ? (event.meta as Prisma.InputJsonValue) : undefined,
          source: 'server',
        },
      });
    } catch (err) {
      this.logger.warn(`could not record an event: ${String(err)}`);
    }
  }

  /**
   * A line the app posted into the owner's chat window. If the server already
   * wrote that exact line a moment ago (every question that reached the AI),
   * the app's copy is absorbed instead of stored twice; anything else — the
   * commands the app handled on its own — is kept as the app reported it.
   */
  async mirrorClientLine(line: MirrorInput): Promise<void> {
    if (!this.prisma) return;
    try {
      const text = line.text.trim().slice(0, 1500);
      if (!text) return;
      const twin = await this.prisma.assistantTranscript.findFirst({
        where: {
          ownerId: line.ownerId,
          venueId: line.venueId,
          sender: line.sender,
          text,
          source: 'server',
          clientCopy: false,
          createdAt: { gte: new Date(Date.now() - MIRROR_WINDOW_MS) },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (twin) {
        await this.prisma.assistantTranscript.update({ where: { id: twin.id }, data: { clientCopy: true } });
        return;
      }
      await this.prisma.assistantTranscript.create({
        data: {
          ownerId: line.ownerId,
          ownerName: line.ownerName ?? null,
          venueId: line.venueId,
          venueName: await this.venueName(line.venueId),
          sender: line.sender,
          kind: line.scheduleChange ? 'schedule' : 'chat',
          text,
          flags: line.sender === 'owner' ? flagsFor({ text }) : [],
          source: 'client',
        },
      });
    } catch (err) {
      this.logger.warn(`could not mirror a line: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------ reading ----

  async list(f: TranscriptFilters) {
    const where: Prisma.AssistantTranscriptWhereInput = {
      ...(f.ownerId ? { ownerId: f.ownerId } : {}),
      ...(f.venueId ? { venueId: f.venueId } : {}),
      ...(f.sender ? { sender: f.sender } : {}),
      ...(f.outcome ? { outcome: f.outcome } : {}),
      ...(f.flag ? { flags: { has: f.flag } } : {}),
      ...(f.notable ? { NOT: { flags: { isEmpty: true } } } : {}),
      ...(f.q
        ? {
            OR: [
              { text: { contains: f.q.slice(0, 80), mode: 'insensitive' as const } },
              { ownerName: { contains: f.q.slice(0, 80), mode: 'insensitive' as const } },
              { venueName: { contains: f.q.slice(0, 80), mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(f.from || f.to
        ? {
            createdAt: {
              ...(f.from ? { gte: new Date(f.from) } : {}),
              ...(f.to ? { lt: new Date(new Date(f.to).getTime() + 86_400_000) } : {}),
            },
          }
        : {}),
    };
    if (!this.prisma) return { items: [], pagination: buildPagination(f.page, f.perPage, 0) };
    const [total, rows] = await Promise.all([
      this.prisma.assistantTranscript.count({ where }),
      this.prisma.assistantTranscript.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (f.page - 1) * f.perPage,
        take: f.perPage,
      }),
    ]);
    return { items: rows.map(present), pagination: buildPagination(f.page, f.perPage, total) };
  }

  /** One owner's whole history, newest first, in pages the admin's user screen loads on demand. */
  async forOwner(ownerId: string, limit = 30, cursor?: string) {
    if (!this.prisma) return { items: [], nextCursor: null };
    const rows = await this.prisma.assistantTranscript.findMany({
      where: { ownerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 100) + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const size = Math.min(Math.max(limit, 1), 100);
    const page = rows.slice(0, size);
    return {
      items: page.map(present),
      nextCursor: rows.length > size ? page[page.length - 1].id : null,
    };
  }

  /** The numbers the admin's "owners" tab opens with: how much, and how much of it went wrong. */
  async summary(days = 7) {
    const empty = { days, total: 0, owners: 0, flags: {} as Record<string, number>, topOwners: [] as unknown[] };
    if (!this.prisma) return empty;
    const since = new Date(Date.now() - Math.min(Math.max(days, 1), 90) * 86_400_000);
    const [total, owners, flagged, perOwner] = await Promise.all([
      this.prisma.assistantTranscript.count({ where: { createdAt: { gte: since }, sender: 'owner' } }),
      this.prisma.assistantTranscript.findMany({ where: { createdAt: { gte: since }, sender: 'owner' }, distinct: ['ownerId'], select: { ownerId: true } }),
      this.prisma.assistantTranscript.findMany({
        where: { createdAt: { gte: since }, sender: 'owner', NOT: { flags: { isEmpty: true } } },
        select: { ownerId: true, ownerName: true, flags: true },
        take: 5000,
      }),
      this.prisma.assistantTranscript.groupBy({
        by: ['ownerId'],
        where: { createdAt: { gte: since }, sender: 'owner' },
        _count: { _all: true },
      }),
    ]);
    const flags: Record<string, number> = Object.fromEntries(TRANSCRIPT_FLAGS.map((f) => [f, 0]));
    const perOwnerFlagged = new Map<string, { name: string | null; count: number }>();
    for (const row of flagged) {
      for (const f of row.flags) flags[f] = (flags[f] ?? 0) + 1;
      const cur = perOwnerFlagged.get(row.ownerId) ?? { name: row.ownerName, count: 0 };
      cur.count += 1;
      perOwnerFlagged.set(row.ownerId, cur);
    }
    const totals = new Map(perOwner.map((o) => [o.ownerId, o._count._all]));
    const topOwners = [...perOwnerFlagged.entries()]
      .map(([ownerId, v]) => ({ ownerId, name: v.name, flagged: v.count, total: totals.get(ownerId) ?? v.count }))
      .sort((a, b) => b.flagged - a.flagged)
      .slice(0, 8);
    return { days, total, owners: owners.length, flags, topOwners };
  }

  // ----------------------------------------------------------- helpers ----

  private async venueName(venueId: string | null | undefined): Promise<string | null> {
    if (!venueId || !this.prisma) return null;
    const hit = this.names.get(venueId);
    if (hit && hit.exp > Date.now()) return hit.value;
    try {
      const v = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { nameAr: true, nameEn: true } });
      const value = v ? v.nameAr || v.nameEn : null;
      this.names.set(venueId, { value, exp: Date.now() + NAME_TTL_MS });
      if (this.names.size > 500) this.names.clear();
      return value;
    } catch {
      return null;
    }
  }
}
