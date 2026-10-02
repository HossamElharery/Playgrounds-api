import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiUsageService } from './ai-usage.service';
import {
  AiUnavailableError,
  type AiProfile,
  type AiProviderName,
  type AiReasoningEffort,
  type StructuredIntentRequest,
  type StructuredIntentResult,
} from './ai-provider.types';

const OWNER_TIMEOUT_MS = 12_000;
const PUBLIC_TIMEOUT_MS = 9_000;
/** No new route is tried after this long: an answer that late is worse than the keyword fallback. */
const TOTAL_DEADLINE_MS = 22_000;
const BREAKER_FAILURES = 3;
const BREAKER_OPEN_MS = 120_000;
const BREAKER_OUT_OF_CREDIT_MS = 10 * 60_000;
const BREAKER_RATE_LIMIT_MS = 30_000;
const CACHE_MAX = 300;

/**
 * Where each audience's sentences may go, best first. The owner assistant sees
 * customer names and amounts, so it stays on Google's models; players and
 * visitors send search intent only, so a cheaper second opinion is fine there.
 */
const DEFAULT_MODELS: Record<AiProfile, string[]> = {
  owner: ['google/gemini-3.8-flash', 'google/gemini-3.6-flash', 'google/gemini-3.5-flash'],
  public: ['google/gemini-3.8-flash', 'google/gemini-3.6-flash', 'deepseek/deepseek-v4.1-flash'],
};
/** Last resort for public traffic only: free, rate-limited, and never given private data. */
const PUBLIC_FREE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

const DEFAULT_REASONING: Record<AiProfile, AiReasoningEffort> = {
  owner: 'low',
  public: 'minimal',
};

type Step = { kind: 'openrouter'; model: string } | { kind: 'gemini'; model: string };

/** A failure we fall back on. `status` tells an auth/credit problem from a rate limit or an outage. */
class AiCallFailure extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  return JSON.parse(candidate);
}

/**
 * Single entry point for every AI call in the app. It walks a per-audience
 * chain of models (OpenRouter first, the direct Gemini key as an extra), skips
 * routes whose breaker is open, enforces the day's budget, and hands back the
 * same shape whichever model answered. Callers re-validate every field — this
 * layer proves the reply is well-formed JSON, never that it is right.
 */
@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);
  private readonly geminiApiKey: string;
  private readonly geminiModel: string;
  private readonly openRouterApiKey: string;
  private readonly forceFailure: string;
  private readonly breakers = new Map<string, { fails: number; openUntil: number; reason?: 'credit' | 'rate_limit' | 'auth' | 'errors' }>();
  private readonly cache = new Map<string, { exp: number; value: StructuredIntentResult }>();

  constructor(
    private readonly config: ConfigService,
    private readonly usage: AiUsageService,
  ) {
    this.geminiApiKey = this.config.get<string>('GEMINI_API_KEY') ?? '';
    this.geminiModel = this.config.get<string>('GEMINI_MODEL') ?? 'gemini-3.8-flash';
    this.openRouterApiKey = this.config.get<string>('OPENROUTER_API_KEY') ?? '';
    // TEST ONLY — see .env.example. Must never be set in a deployed environment.
    this.forceFailure = this.config.get<string>('AI_FORCE_FAILURE') ?? '';
  }

  get enabled(): boolean {
    return this.geminiApiKey.length > 0 || this.openRouterApiKey.length > 0;
  }

  /** The routes this audience may use, in order. Exposed for the admin view and the tests. */
  chain(profile: AiProfile, override?: string[]): Step[] {
    const steps: Step[] = [];
    if (override?.length && profile === 'public' && this.openRouterApiKey) {
      return override.map((model) => ({ kind: 'openrouter' as const, model }));
    }
    if (this.openRouterApiKey) {
      const key = profile === 'owner' ? 'AI_OWNER_MODELS' : 'AI_PUBLIC_MODELS';
      const custom = (this.config.get<string>(key) ?? '')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
      for (const model of custom.length ? custom : DEFAULT_MODELS[profile]) {
        steps.push({ kind: 'openrouter', model });
      }
    }
    if (this.geminiApiKey) steps.push({ kind: 'gemini', model: this.geminiModel });
    if (profile === 'public' && this.openRouterApiKey) {
      steps.push({ kind: 'openrouter', model: PUBLIC_FREE_MODEL });
    }
    return steps;
  }

  async getStructuredIntent(req: StructuredIntentRequest): Promise<StructuredIntentResult> {
    const profile: AiProfile = req.profile ?? 'owner';
    const cacheKey = req.cacheTtlMs ? this.cacheKey(profile, req) : null;
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.exp > Date.now()) return { ...hit.value, ms: 0, costUsd: 0 };
    }
    if (!req.skipBudget) this.usage.assertBudget(profile);

    const started = Date.now();
    const timeoutMs = req.timeoutMs ?? (profile === 'owner' ? OWNER_TIMEOUT_MS : PUBLIC_TIMEOUT_MS);
    const reasoning = req.reasoning ?? this.reasoningFor(profile);

    const steps = this.chain(profile, req.modelsOverride);
    for (const [routeIndex, step] of steps.entries()) {
      if (Date.now() - started > TOTAL_DEADLINE_MS) break;
      const id = `${step.kind}:${step.model}`;
      if (this.breakerOpen(id)) continue;
      const t0 = Date.now();
      try {
        const out =
          step.kind === 'openrouter'
            ? await this.callOpenRouter(step.model, req, timeoutMs, reasoning)
            : await this.callGemini(req, timeoutMs);
        this.breakers.delete(id);
        const result: StructuredIntentResult = {
          raw: out.raw,
          provider: step.kind,
          model: step.model,
          costUsd: out.costUsd,
          ms: Date.now() - t0,
        };
        this.usage.record({ profile, provider: step.kind, model: step.model, ok: true, ms: result.ms, costUsd: out.costUsd, routeIndex });
        if (cacheKey && req.cacheTtlMs) this.remember(cacheKey, result, req.cacheTtlMs);
        return result;
      } catch (err) {
        const failure = err instanceof AiCallFailure ? err : new AiCallFailure(String(err));
        this.usage.record({
          profile,
          provider: step.kind,
          model: step.model,
          ok: false,
          ms: Date.now() - t0,
          costUsd: 0,
          status: failure.status,
          routeIndex,
        });
        this.noteFailure(id, step, failure);
      }
    }
    throw new AiUnavailableError();
  }

  /** Which routes are paused right now and why, for the admin overview. */
  breakerStates(): { id: string; kind: string; model: string; reason: 'credit' | 'rate_limit' | 'auth' | 'errors'; openUntil: number }[] {
    const now = Date.now();
    const out: { id: string; kind: string; model: string; reason: 'credit' | 'rate_limit' | 'auth' | 'errors'; openUntil: number }[] = [];
    for (const [id, b] of this.breakers) {
      if (b.openUntil <= now) continue;
      const [kind, ...rest] = id.split(':');
      out.push({ id, kind, model: rest.join(':'), reason: b.reason ?? 'errors', openUntil: b.openUntil });
    }
    return out;
  }

  private reasoningFor(profile: AiProfile): AiReasoningEffort {
    const raw = (this.config.get<string>(profile === 'owner' ? 'AI_OWNER_REASONING' : 'AI_PUBLIC_REASONING') ?? '').trim();
    return (['minimal', 'low', 'medium', 'high'] as const).includes(raw as AiReasoningEffort)
      ? (raw as AiReasoningEffort)
      : DEFAULT_REASONING[profile];
  }

  // ---------------------------------------------------------- breaker ----

  private breakerOpen(id: string): boolean {
    const b = this.breakers.get(id);
    return !!b && Date.now() < b.openUntil;
  }

  private noteFailure(id: string, step: Step, failure: AiCallFailure): void {
    const label = `${step.kind}:${step.model}`;
    if (failure.status === 401 || failure.status === 403) {
      this.logger.error(`[ai-provider] ${label} AUTH FAILURE (${failure.status}) — check the API key configuration`);
      this.breakers.set(id, { fails: 0, openUntil: Date.now() + BREAKER_OPEN_MS, reason: 'auth' });
      return;
    }
    if (failure.status === 402) {
      this.logger.error(`[ai-provider] ${label} OUT OF CREDIT (402) — top up OpenRouter; paused for 10 minutes`);
      this.breakers.set(id, { fails: 0, openUntil: Date.now() + BREAKER_OUT_OF_CREDIT_MS, reason: 'credit' });
      return;
    }
    if (failure.status === 429) {
      this.logger.warn(`[ai-provider] ${label} rate limited (429) — paused for 30s`);
      this.breakers.set(id, { fails: 0, openUntil: Date.now() + BREAKER_RATE_LIMIT_MS, reason: 'rate_limit' });
      return;
    }
    const fails = (this.breakers.get(id)?.fails ?? 0) + 1;
    if (fails >= BREAKER_FAILURES) {
      this.breakers.set(id, { fails: 0, openUntil: Date.now() + BREAKER_OPEN_MS, reason: 'errors' });
      this.logger.warn(`[ai-provider] ${label} circuit-open for ${BREAKER_OPEN_MS / 1000}s after ${BREAKER_FAILURES} failures`);
    } else {
      this.breakers.set(id, { fails, openUntil: 0 });
      this.logger.warn(`[ai-provider] ${label} failed: ${failure.message} -> next route`);
    }
  }

  // ------------------------------------------------------------ cache ----

  private cacheKey(profile: AiProfile, req: StructuredIntentRequest): string {
    return `${profile}\u0000${req.systemPrompt.length}\u0000${req.systemPrompt.slice(-200)}\u0000${req.userPrompt}`;
  }

  private remember(key: string, value: StructuredIntentResult, ttl: number): void {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { exp: Date.now() + ttl, value });
  }

  // ---------------------------------------------------------- routes ----

  private async callOpenRouter(
    model: string,
    req: StructuredIntentRequest,
    timeoutMs: number,
    reasoning: AiReasoningEffort,
  ): Promise<{ raw: string; costUsd: number }> {
    if (this.forceFailure === 'openrouter') {
      throw new AiCallFailure('forced-failure (AI_FORCE_FAILURE=openrouter)');
    }
    const schemaHint = req.responseSchema
      ? `\n\nRespond with a single JSON object only (no prose, no markdown fences) matching exactly this structure: ${JSON.stringify(req.responseSchema)}`
      : '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.openRouterApiKey}`,
          'X-Title': 'Matchena',
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          usage: { include: true },
          // Reasoning is billed as output: "minimal" keeps a search reading at a fraction of a cent.
          reasoning: { effort: reasoning },
          messages: [
            { role: 'system', content: req.systemPrompt + schemaHint },
            { role: 'user', content: req.userPrompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new AiCallFailure(`HTTP ${res.status}`, res.status);
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { cost?: number };
      };
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new AiCallFailure('empty response');
      return { raw: JSON.stringify(extractJson(text)), costUsd: Number(json?.usage?.cost) || 0 };
    } catch (err) {
      if (err instanceof AiCallFailure) throw err;
      if ((err as { name?: string }).name === 'AbortError') throw new AiCallFailure('timeout');
      if (err instanceof SyntaxError) throw new AiCallFailure('unparseable JSON');
      throw new AiCallFailure(String(err));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callGemini(
    req: StructuredIntentRequest,
    timeoutMs: number,
  ): Promise<{ raw: string; costUsd: number }> {
    if (this.forceFailure === 'gemini') {
      throw new AiCallFailure('forced-failure (AI_FORCE_FAILURE=gemini)');
    }
    const body = {
      contents: [{ role: 'user', parts: [{ text: req.userPrompt }] }],
      systemInstruction: { parts: [{ text: req.systemPrompt }] },
      generationConfig: {
        responseMimeType: 'application/json',
        ...(req.responseSchema ? { responseSchema: req.responseSchema } : {}),
      },
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.geminiApiKey },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );
        clearTimeout(timeout);
        if (res.status === 503 && attempt === 1) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        if (!res.ok) throw new AiCallFailure(`HTTP ${res.status}`, res.status);
        const json = await res.json();
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== 'string' || !text.trim()) throw new AiCallFailure('empty response');
        return { raw: JSON.stringify(extractJson(text)), costUsd: 0 };
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof AiCallFailure) throw err;
        if ((err as { name?: string }).name === 'AbortError') throw new AiCallFailure('timeout');
        if (attempt === 2 || err instanceof SyntaxError) {
          throw err instanceof SyntaxError ? new AiCallFailure('unparseable JSON') : new AiCallFailure(String(err));
        }
      }
    }
    throw new AiCallFailure('exhausted retries');
  }
}
