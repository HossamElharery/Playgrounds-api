import { AiProviderService } from '../ai-provider.service';
import { AiUnavailableError, type AiReasoningEffort } from '../ai-provider.types';
import type { AiCallRecord, AiUsageService } from '../ai-usage.service';
import { CaptainNluService } from '../../search/captain/captain-nlu.service';
import { AssistantNluService } from '../../owner/assistant/assistant-nlu.service';
import { KNOWLEDGE, type KnowledgeEntry } from '../knowledge/default-knowledge';
import type { CaptainReading } from '../../search/captain/captain.types';
import type { AssistantReading } from '../../owner/assistant/assistant.types';
import { CAPTAIN_CASES, EVAL_COURTS, EVAL_TODAY, OWNER_CASES, evalContext } from './ai-eval.cases';

export type EvalKind = 'captain' | 'owner';

export interface EvalFailure {
  q: string;
  got: string;
}

export interface EvalSummary {
  kind: EvalKind;
  model: string;
  reasoning: string;
  pass: number;
  total: number;
  ran: number;
  truncated: boolean;
  avgMs: number;
  calls: number;
  failedCalls: number;
  costUsd: number;
  failures: EvalFailure[];
}

export interface EvalRunOptions {
  kind: EvalKind;
  model: string;
  reasoning?: AiReasoningEffort;
  env: (name: string) => string | undefined;
  maxCostUsd?: number;
  concurrency?: number;
  sink?: Pick<AiUsageService, 'record'>;
  knowledge?: KnowledgeEntry[];
  onProgress?: (done: number, total: number) => void;
}

class EvalMeter {
  calls = 0;
  failures = 0;
  costUsd = 0;
  constructor(private readonly sink?: Pick<AiUsageService, 'record'>) {}
  assertBudget(): void {}
  record(call: AiCallRecord): void {
    this.calls += 1;
    if (!call.ok) this.failures += 1;
    this.costUsd += call.costUsd;
    this.sink?.record(call);
  }
}

function compare(expect: Record<string, unknown>, got: Record<string, unknown>, json: boolean): string[] {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(expect)) {
    if (k === 'factIdsAny') {
      const ids = (got['factIds'] as string[]) ?? [];
      if (!(v as string[]).some((id) => ids.includes(id))) bad.push(`factIds=${JSON.stringify(ids)} want any of ${JSON.stringify(v)}`);
      continue;
    }
    const value = got[k];
    const same = json ? JSON.stringify(value) === JSON.stringify(v) : value === v;
    if (!same) bad.push(`${k}=${JSON.stringify(value)} want ${JSON.stringify(v)}`);
  }
  return bad;
}

export async function runEvalSuite(opts: EvalRunOptions): Promise<EvalSummary> {
  const overrides: Record<string, string | undefined> = {
    GEMINI_API_KEY: '',
    AI_OWNER_MODELS: opts.model,
    AI_PUBLIC_MODELS: opts.model,
    AI_OWNER_REASONING: opts.reasoning,
    AI_PUBLIC_REASONING: opts.reasoning,
  };
  const config = { get: (k: string) => (k in overrides ? overrides[k] : opts.env(k)) } as never;
  const meter = new EvalMeter(opts.sink);
  const provider = new AiProviderService(config, meter as unknown as AiUsageService);

  const cases = opts.kind === 'captain' ? CAPTAIN_CASES : OWNER_CASES;
  const knowledge = opts.knowledge ?? KNOWLEDGE;
  const captain = new CaptainNluService(provider, evalContext as never);
  const owner = new AssistantNluService(provider, evalContext as never);
  const cap = opts.maxCostUsd ?? Infinity;

  const failures: EvalFailure[] = [];
  let pass = 0;
  let ran = 0;
  let truncated = false;
  let next = 0;
  const started = Date.now();

  const one = async (index: number): Promise<void> => {
    const c = cases[index];
    try {
      let bad: string[];
      if (opts.kind === 'captain') {
        const cc = c as (typeof CAPTAIN_CASES)[number];
        const reading: CaptainReading | null = await captain.read({
          text: cc.q,
          lang: /[؀-ۿ]/.test(cc.q) ? 'ar' : 'en',
          loggedIn: cc.loggedIn ?? false,
          hasCoords: false,
          history: cc.history ?? [],
          context: cc.context ?? null,
          knowledge,
        });
        bad = reading ? compare(cc.expect as Record<string, unknown>, reading as unknown as Record<string, unknown>, false) : ['null (no answer)'];
      } else {
        const oc = c as (typeof OWNER_CASES)[number];
        const reading: AssistantReading | null = await owner.read(
          oc.q,
          EVAL_COURTS,
          EVAL_TODAY,
          [{ name: 'محمد', courtName: 'PS5 Room 1', time: '19:00', outstanding: 200 }],
          { venueName: 'نيون', nowHhmm: '14:30', draft: oc.draft ?? null },
        );
        bad = reading ? compare(oc.expect as Record<string, unknown>, reading as unknown as Record<string, unknown>, true) : ['null (no answer)'];
      }
      if (bad.length === 0) pass += 1;
      else failures.push({ q: c.q, got: bad.join('; ') });
    } catch (err) {
      failures.push({ q: c.q, got: err instanceof AiUnavailableError ? 'unavailable' : String(err) });
    } finally {
      ran += 1;
      opts.onProgress?.(ran, cases.length);
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (meter.costUsd >= cap) {
        truncated = true;
        return;
      }
      const index = next++;
      if (index >= cases.length) return;
      await one(index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, opts.concurrency ?? 1)) }, () => worker()));

  return {
    kind: opts.kind,
    model: opts.model,
    reasoning: opts.reasoning ?? 'default',
    pass,
    total: cases.length,
    ran,
    truncated,
    avgMs: Math.round((Date.now() - started) / Math.max(1, ran)),
    calls: meter.calls,
    failedCalls: meter.failures,
    costUsd: Number(meter.costUsd.toFixed(6)),
    failures,
  };
}

export const EVAL_CASE_COUNTS = { captain: CAPTAIN_CASES.length, owner: OWNER_CASES.length };
