import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiProviderService } from '../ai-provider.service';
import { AiUsageService } from '../ai-usage.service';
import { AssistantKnowledgeService } from '../knowledge/assistant-knowledge.service';
import { CaptainNluService } from '../../search/captain/captain-nlu.service';
import { EVAL_CASE_COUNTS, runEvalSuite, type EvalKind, type EvalSummary } from '../eval/ai-eval.runner';
import { fromMicros, toMicros } from '../ai-day';
import type { AiReasoningEffort } from '../ai-provider.types';

const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;
const MAX_MODELS_PER_RUN = 3;
/** A run stops starting new cases once it has spent this much; the total for a job is capped too. */
const MAX_COST_PER_MODEL_USD = 0.25;
const MAX_COST_PER_JOB_USD = 0.5;
const MIN_GAP_MS = 30_000;
const SHADOW_MAX_SAMPLE = 40;
const SHADOW_MAX_COST_USD = 0.25;
const JOB_KEEP_MS = 10 * 60_000;
/** Rough prices per model for the "this will cost about" line: what the last measured runs came to. */
const ESTIMATE_PER_CASE_USD = { captain: 0.0015, owner: 0.002 };

export interface Job {
  id: string;
  kind: 'eval' | 'shadow';
  status: 'running' | 'done' | 'failed';
  done: number;
  total: number;
  startedAt: string;
  runId: string | null;
  error: string | null;
}

interface ShadowDiff {
  text: string;
  baseline: { intent: string | null; sport: string | null; district: string | null; factIds: string[]; model: string | null };
  candidate: { intent: string | null; sport: string | null; district: string | null; factIds: string[] };
}

const REASONINGS: AiReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

/** Quality runs for the admin: the `ai:eval` cases on demand, and shadow comparison of a candidate model on real (redacted) questions. */
@Injectable()
export class AiAdminQualityService {
  private readonly logger = new Logger(AiAdminQualityService.name);
  private job: Job | null = null;
  private lastStartAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly provider: AiProviderService,
    private readonly usage: AiUsageService,
    private readonly knowledge: AssistantKnowledgeService,
    private readonly nlu: CaptainNluService,
  ) {}

  async overview() {
    const runs = await this.prisma.aiEvalRun.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
    const first = (profile: 'owner' | 'public') => this.provider.chain(profile).find((s) => s.kind === 'openrouter')?.model ?? null;
    return {
      canRun: this.provider.enabled && !!(this.config.get<string>('OPENROUTER_API_KEY') ?? ''),
      cases: EVAL_CASE_COUNTS,
      estimateUsd: {
        captain: Number((EVAL_CASE_COUNTS.captain * ESTIMATE_PER_CASE_USD.captain).toFixed(3)),
        owner: Number((EVAL_CASE_COUNTS.owner * ESTIMATE_PER_CASE_USD.owner).toFixed(3)),
      },
      defaults: { captain: first('public'), owner: first('owner') },
      limits: { maxModels: MAX_MODELS_PER_RUN, maxCostPerModelUsd: MAX_COST_PER_MODEL_USD, maxCostPerJobUsd: MAX_COST_PER_JOB_USD, shadowMaxSample: SHADOW_MAX_SAMPLE, shadowMaxCostUsd: SHADOW_MAX_COST_USD },
      job: this.currentJob(),
      runs: runs.map((r) => this.presentRun(r)),
    };
  }

  async getRun(id: string) {
    const r = await this.prisma.aiEvalRun.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('run not found');
    return { ...this.presentRun(r), detail: r.summary };
  }

  private presentRun(r: { id: string; createdAt: Date; kind: string; models: string[]; source: string; passed: number; total: number; costMicros: number; durationMs: number; summary: Prisma.JsonValue }) {
    const s = (r.summary ?? {}) as { results?: EvalSummary[]; shadow?: Record<string, unknown> };
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      kind: r.kind,
      models: r.models,
      source: r.source,
      passed: r.passed,
      total: r.total,
      costUsd: Number(fromMicros(r.costMicros).toFixed(4)),
      durationMs: r.durationMs,
      results: (s.results ?? []).map((x) => ({
        kind: x.kind,
        model: x.model,
        reasoning: x.reasoning,
        pass: x.pass,
        total: x.total,
        ran: x.ran,
        truncated: x.truncated,
        avgMs: x.avgMs,
        costUsd: x.costUsd,
        failures: x.failures.slice(0, 40),
      })),
      shadow: s.shadow ?? null,
    };
  }

  currentJob(): Job | null {
    if (this.job && this.job.status !== 'running' && Date.now() - new Date(this.job.startedAt).getTime() > JOB_KEEP_MS) this.job = null;
    return this.job;
  }

  jobStatus(id: string): Job {
    const j = this.currentJob();
    if (!j || j.id !== id) throw new NotFoundException('job not found');
    return j;
  }

  private begin(kind: Job['kind'], total: number): Job {
    if (this.job?.status === 'running') throw new ConflictException('a quality run is already in progress');
    if (Date.now() - this.lastStartAt < MIN_GAP_MS) throw new HttpException('wait a moment between quality runs', HttpStatus.TOO_MANY_REQUESTS);
    this.lastStartAt = Date.now();
    this.job = { id: randomUUID(), kind, status: 'running', done: 0, total, startedAt: new Date().toISOString(), runId: null, error: null };
    return this.job;
  }

  private checkModels(models: string[], kind: EvalKind): string[] {
    const clean = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
    if (!clean.length || clean.length > MAX_MODELS_PER_RUN) throw new BadRequestException(`give 1-${MAX_MODELS_PER_RUN} models`);
    for (const m of clean) {
      if (!MODEL_ID.test(m) || m.length > 100) throw new BadRequestException(`not a model id: ${m.slice(0, 40)}`);
      // The owner assistant's real traffic never leaves Google's models; its quality runs follow the same rule.
      if (kind === 'owner' && !m.startsWith('google/')) throw new BadRequestException('the owner assistant is only evaluated on google/* models');
    }
    return clean;
  }

  // ----------------------------------------------------------- eval run ----

  async startEval(body: { kind: 'captain' | 'owner' | 'both'; models?: string[]; reasoning?: string }, actorUserId: string) {
    if (!this.provider.enabled) throw new BadRequestException('no AI key is configured');
    const kinds: EvalKind[] = body.kind === 'both' ? ['captain', 'owner'] : [body.kind];
    if (body.reasoning && !REASONINGS.includes(body.reasoning as AiReasoningEffort)) throw new BadRequestException('bad reasoning level');
    const reasoning = body.reasoning as AiReasoningEffort | undefined;

    const plan: { kind: EvalKind; models: string[] }[] = kinds.map((kind) => {
      const fallback = this.provider.chain(kind === 'owner' ? 'owner' : 'public').find((s) => s.kind === 'openrouter')?.model;
      const raw = body.models?.length ? body.models : fallback ? [fallback] : [];
      return { kind, models: this.checkModels(raw, kind) };
    });
    const total = plan.reduce((n, p) => n + p.models.length * EVAL_CASE_COUNTS[p.kind], 0);
    const job = this.begin('eval', total);
    void this.runEval(job, plan, reasoning, actorUserId);
    return job;
  }

  private async runEval(job: Job, plan: { kind: EvalKind; models: string[] }[], reasoning: AiReasoningEffort | undefined, actorUserId: string): Promise<void> {
    const started = Date.now();
    try {
      let spentJob = 0;
      const knowledge = await this.knowledge.forPlayers();
      let doneBefore = 0;
      for (const { kind, models } of plan) {
        const results: EvalSummary[] = [];
        const kindStarted = Date.now();
        for (const model of models) {
          const remaining = MAX_COST_PER_JOB_USD - spentJob;
          if (remaining <= 0) break;
          const base = doneBefore;
          const r = await runEvalSuite({
            kind,
            model,
            reasoning,
            env: (k) => this.config.get<string>(k),
            maxCostUsd: Math.min(MAX_COST_PER_MODEL_USD, remaining),
            concurrency: 4,
            sink: this.usage,
            knowledge,
            onProgress: (done) => {
              job.done = base + done;
            },
          });
          spentJob += r.costUsd;
          doneBefore += EVAL_CASE_COUNTS[kind];
          job.done = doneBefore;
          results.push(r);
        }
        if (!results.length) continue;
        const run = await this.prisma.aiEvalRun.create({
          data: {
            kind,
            models: results.map((r) => r.model),
            source: 'admin',
            passed: results.reduce((n, r) => n + r.pass, 0),
            total: results.reduce((n, r) => n + r.total, 0),
            costMicros: toMicros(results.reduce((n, r) => n + r.costUsd, 0)),
            durationMs: Date.now() - kindStarted,
            summary: { results } as unknown as Prisma.InputJsonValue,
            triggeredById: actorUserId,
          },
        });
        job.runId = run.id;
      }
      await this.prisma.auditLogEntry.create({
        data: { actorUserId, action: 'ai.eval.run', targetType: 'ai_eval', targetId: job.id, metadata: { plan, spentUsd: Number(spentJob.toFixed(4)), ms: Date.now() - started } as Prisma.InputJsonValue },
      });
      job.status = 'done';
    } catch (err) {
      this.logger.warn(`[ai-quality] eval run failed: ${String(err)}`);
      job.status = 'failed';
      job.error = 'run_failed';
    }
  }

  // -------------------------------------------------------------- shadow ----

  /**
   * Replays a sample of real (already redacted) player questions on a candidate
   * model and shows where it reads them differently from the model that really
   * answered. Nothing is shown to any player; the candidate's answers go nowhere
   * but this report. Multi-turn context is not replayed, so follow-ups can differ for that reason alone.
   */
  async startShadow(body: { model: string; sampleSize?: number; days?: number }, actorUserId: string) {
    if (!this.provider.enabled) throw new BadRequestException('no AI key is configured');
    const [model] = this.checkModels([body.model], 'captain');
    const sampleSize = Math.max(5, Math.min(SHADOW_MAX_SAMPLE, body.sampleSize ?? 25));
    const days = Math.max(1, Math.min(30, body.days ?? 7));
    const rows = await this.prisma.aiQuestionLog.findMany({
      where: {
        surface: 'captain',
        createdAt: { gte: new Date(Date.now() - days * 86_400_000) },
        outcome: { notIn: ['limited', 'blocked', 'unavailable'] },
        model: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    if (rows.length < 5) throw new BadRequestException('not enough recent questions to compare yet');
    const sample = [...rows].sort(() => Math.random() - 0.5).slice(0, sampleSize);
    const job = this.begin('shadow', sample.length);
    void this.runShadow(job, model, sample, actorUserId);
    return job;
  }

  private async runShadow(
    job: Job,
    model: string,
    sample: { id: string; textRedacted: string; lang: string | null; userKind: string; model: string | null; ms: number; intent: string | null; factIds: string[]; reading: Prisma.JsonValue }[],
    actorUserId: string,
  ): Promise<void> {
    const started = Date.now();
    try {
      const knowledge = await this.knowledge.forPlayers();
      const diffs: ShadowDiff[] = [];
      let compared = 0;
      let agree = 0;
      let intentAgree = 0;
      let candidateMs = 0;
      let candidateCalls = 0;
      let cost = 0;
      let answered = 0;
      let next = 0;
      const baselineMs = sample.filter((s) => s.ms > 0).map((s) => s.ms);

      const worker = async () => {
        for (;;) {
          if (cost >= SHADOW_MAX_COST_USD) return;
          const row = sample[next++];
          if (!row) return;
          const reading = await this.nlu.read({
            text: row.textRedacted,
            lang: (row.lang as 'ar' | 'en' | null) ?? (/[؀-ۿ]/.test(row.textRedacted) ? 'ar' : 'en'),
            loggedIn: row.userKind === 'player',
            hasCoords: false,
            history: [],
            context: null,
            knowledge,
            modelsOverride: [model],
            skipBudget: true,
          });
          job.done += 1;
          if (!reading) continue;
          answered += 1;
          cost += reading.meta?.costUsd ?? 0;
          candidateMs += reading.meta?.ms ?? 0;
          candidateCalls += 1;
          const base = (row.reading ?? {}) as Record<string, unknown>;
          const baseline = {
            intent: row.intent,
            sport: (base['sport'] as string | null) ?? null,
            district: (base['district'] as string | null) ?? null,
            factIds: row.factIds,
            model: row.model,
          };
          const candidate = { intent: reading.intent, sport: reading.sport, district: reading.district, factIds: reading.factIds };
          compared += 1;
          const sameIntent = baseline.intent === candidate.intent;
          if (sameIntent) intentAgree += 1;
          const sameDetail =
            candidate.intent === 'faq'
              ? baseline.factIds.length === candidate.factIds.length && baseline.factIds.every((f) => candidate.factIds.includes(f))
              : candidate.intent === 'find_venues'
                ? baseline.sport === candidate.sport && baseline.district === candidate.district
                : true;
          if (sameIntent && sameDetail) agree += 1;
          else if (diffs.length < 40) diffs.push({ text: row.textRedacted, baseline, candidate });
        }
      };
      await Promise.all(Array.from({ length: 3 }, () => worker()));

      const shadow = {
        candidate: model,
        sampleSize: sample.length,
        compared,
        noAnswer: sample.length - answered,
        agree,
        agreementPct: compared ? Math.round((100 * agree) / compared) : 0,
        intentAgreementPct: compared ? Math.round((100 * intentAgree) / compared) : 0,
        candidateAvgMs: candidateCalls ? Math.round(candidateMs / candidateCalls) : 0,
        baselineAvgMs: baselineMs.length ? Math.round(baselineMs.reduce((n, v) => n + v, 0) / baselineMs.length) : 0,
        costUsd: Number(cost.toFixed(4)),
        truncated: cost >= SHADOW_MAX_COST_USD,
        diffs,
      };
      const run = await this.prisma.aiEvalRun.create({
        data: {
          kind: 'shadow',
          models: [model],
          source: 'admin',
          passed: agree,
          total: compared,
          costMicros: toMicros(cost),
          durationMs: Date.now() - started,
          summary: { shadow } as unknown as Prisma.InputJsonValue,
          triggeredById: actorUserId,
        },
      });
      job.runId = run.id;
      await this.prisma.auditLogEntry.create({
        data: { actorUserId, action: 'ai.shadow.run', targetType: 'ai_eval', targetId: run.id, metadata: { model, sample: sample.length, costUsd: shadow.costUsd } as Prisma.InputJsonValue },
      });
      job.status = 'done';
    } catch (err) {
      this.logger.warn(`[ai-quality] shadow run failed: ${String(err)}`);
      job.status = 'failed';
      job.error = 'run_failed';
    }
  }
}
