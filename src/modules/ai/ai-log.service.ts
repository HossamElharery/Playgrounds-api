import { randomUUID } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, type AiAskerKind, type AiFeedback, type AiQuestionOutcome, type AiSurface } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiQuotaService } from './ai-quota.service';
import { AiSettingsService } from './ai-settings.service';
import { AiUsageService } from './ai-usage.service';
import { addDays, dayDate, toMicros, utcDayString } from './ai-day';

export interface QuestionLogInput {
  surface?: AiSurface;
  userKind: AiAskerKind;
  /** The player's sentence exactly as typed (trimmed and capped); only admins can read it. */
  text: string;
  lang?: 'ar' | 'en';
  intent?: string;
  outcome: AiQuestionOutcome;
  /** minute | day | budget | spam | noise | guests_off | challenge … */
  detail?: string;
  factIds?: string[];
  reading?: Record<string, unknown>;
  /** null/undefined = no model answered. */
  model?: string | null;
  ms?: number;
  costUsd?: number;
  /** The quota key (`dev:…`, `ip:…`, `user:…`), hashed here into a short reference. */
  askerKey?: string;
}

export interface OwnerEventInput {
  venueId?: string;
  userId?: string;
  event: 'ask' | 'applied' | 'undone';
  intent?: string;
  outcome: 'planned' | 'clarify' | 'denied' | 'unavailable' | 'limited' | 'error' | 'applied' | 'failed';
  /** Controlled vocabulary only (an error class, a reason code) — never anything the owner typed. */
  detail?: string;
  confidence?: number;
  model?: string | null;
  ms?: number;
  costUsd?: number;
}

const OWNER_EVENT_RETENTION_DAYS = 90;
const CALL_ROWS_RETENTION_DAYS = 400;
const COUNTER_RETENTION_DAYS = 7;
const BLOCK_LOG_EVERY_MS = 60_000;

/** A reason or intent code: lower-case words only, so free text can never ride along. */
function code(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const clean = value.toLowerCase().replace(/[^a-z0-9_.:-]/g, '').slice(0, max);
  return clean || null;
}

/**
 * Writes the two logs the admin reads: what players asked Captain (the
 * sentence as typed, admin-only, kept for a fixed window) and what happened to the owner assistant's
 * requests (no text at all). A log write is best effort — it never delays or
 * fails the answer, and a flood of refused messages is counted, not stored row by row.
 */
@Injectable()
export class AiLogService {
  private readonly logger = new Logger(AiLogService.name);
  private readonly recentBlocks = new Map<string, number>();

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly quota?: AiQuotaService,
    @Optional() private readonly usage?: AiUsageService,
    @Optional() private readonly settings?: AiSettingsService,
  ) {}

  /** Returns the id the client can send feedback against, or null when nothing was stored. */
  logQuestion(input: QuestionLogInput): string | null {
    const refused = input.outcome === 'limited' || input.outcome === 'blocked';
    if (refused) this.usage?.bump(`${input.outcome}:${input.detail ?? 'other'}:${input.userKind}`);
    else if (!input.model && input.outcome !== 'unavailable') this.usage?.bump('keyword_fallback:public');

    const askerRef = input.askerKey && this.quota ? this.quota.ref(input.askerKey) : null;
    if (refused) {
      // A script hammering the endpoint would otherwise write a row per refusal.
      const key = `${askerRef ?? 'anon'}|${input.detail ?? ''}`;
      const now = Date.now();
      if (now - (this.recentBlocks.get(key) ?? 0) < BLOCK_LOG_EVERY_MS) return null;
      this.recentBlocks.set(key, now);
      if (this.recentBlocks.size > 2000) this.recentBlocks.clear();
    }
    if (!this.prisma) return null;

    const id = randomUUID();
    this.prisma.aiQuestionLog
      .create({
        data: {
          id,
          surface: input.surface ?? 'captain',
          userKind: input.userKind,
          // The column keeps its old name; the admin asked to see every message exactly as the player wrote it.
          textRedacted: input.text.replace(/\s+/g, ' ').trim().slice(0, 300) || '—',
          lang: input.lang ?? null,
          intent: code(input.intent, 40),
          outcome: input.outcome,
          detail: code(input.detail, 60),
          factIds: (input.factIds ?? []).map((f) => f.slice(0, 60)).slice(0, 5),
          reading: input.reading ? (input.reading as Prisma.InputJsonValue) : undefined,
          model: input.model ? input.model.slice(0, 120) : null,
          ms: Math.max(0, Math.round(input.ms ?? 0)),
          costMicros: toMicros(input.costUsd ?? 0),
          askerRef,
        },
      })
      .catch((err: unknown) => this.logger.warn(`[ai-log] could not store a question: ${String(err)}`));
    return id;
  }

  /** Only the ids this server handed out can be rated, and only for a day. */
  async setFeedback(id: string, value: AiFeedback): Promise<boolean> {
    if (!this.prisma) return false;
    try {
      const res = await this.prisma.aiQuestionLog.updateMany({
        where: { id, surface: 'captain', createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
        data: { feedback: value, feedbackAt: new Date() },
      });
      return res.count > 0;
    } catch (err) {
      this.logger.warn(`[ai-log] feedback not saved: ${String(err)}`);
      return false;
    }
  }

  logOwnerEvent(input: OwnerEventInput): void {
    if (!this.prisma) return;
    this.prisma.aiOwnerEventLog
      .create({
        data: {
          venueId: input.venueId ?? null,
          userId: input.userId ?? null,
          event: input.event,
          intent: code(input.intent, 40),
          outcome: input.outcome,
          detail: code(input.detail, 60),
          confidence: typeof input.confidence === 'number' && Number.isFinite(input.confidence) ? input.confidence : null,
          model: input.model ? input.model.slice(0, 120) : null,
          ms: Math.max(0, Math.round(input.ms ?? 0)),
          costMicros: toMicros(input.costUsd ?? 0),
        },
      })
      .catch((err: unknown) => this.logger.warn(`[ai-log] could not store an owner event: ${String(err)}`));
  }

  /** Retention: the player questions after the admin-set window (30-60 days), the rest after their own, shorter or longer, ones. */
  @Cron('15 3 * * *', { timeZone: 'Africa/Cairo' })
  async purge(): Promise<{ questions: number; ownerEvents: number; counters: number; calls: number } | null> {
    if (!this.prisma) return null;
    try {
      const days = this.settings?.number('questionRetentionDays') ?? 45;
      const now = Date.now();
      const today = utcDayString(now);
      const [questions, ownerEvents, counters, calls] = await Promise.all([
        this.prisma.aiQuestionLog.deleteMany({ where: { createdAt: { lt: new Date(now - days * 86_400_000) } } }),
        this.prisma.aiOwnerEventLog.deleteMany({ where: { createdAt: { lt: new Date(now - OWNER_EVENT_RETENTION_DAYS * 86_400_000) } } }),
        this.prisma.aiCounterDaily.deleteMany({ where: { day: { lt: dayDate(addDays(today, -COUNTER_RETENTION_DAYS)) } } }),
        this.prisma.aiCallDaily.deleteMany({ where: { day: { lt: dayDate(addDays(today, -CALL_ROWS_RETENTION_DAYS)) } } }),
      ]);
      const out = { questions: questions.count, ownerEvents: ownerEvents.count, counters: counters.count, calls: calls.count };
      this.logger.log(`[ai-log] retention swept ${JSON.stringify(out)}`);
      return out;
    } catch (err) {
      this.logger.warn(`[ai-log] retention sweep failed: ${String(err)}`);
      return null;
    }
  }
}
