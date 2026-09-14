import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiProviderName,
  AiUnavailableError,
  StructuredIntentRequest,
  StructuredIntentResult,
} from './ai-provider.types';

const DEFAULT_TIMEOUT_MS = 8_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 120_000;

// See the note in ai-provider.types.ts — these are the free models verified
// working at implementation time, not the originally-suggested llama/qwen
// (both retired from OpenRouter's free tier). "super" goes first: it
// answered correctly on every test call, while "ultra" (a reasoning model)
// intermittently returned empty content on the free tier — see the final
// report for the measured failure rate.
const OPENROUTER_MODELS = {
  'openrouter-nemotron-super': 'nvidia/nemotron-3-super-120b-a12b:free',
  'openrouter-nemotron-ultra': 'nvidia/nemotron-3-ultra-550b-a55b:free',
} as const;

/** A failure we should fall back on. `status` distinguishes an auth problem from a rate-limit/outage. */
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
 * Single entry point for every AI call in the app: Gemini first, then two
 * free OpenRouter models as fallback. Callers never touch Gemini or
 * OpenRouter directly — they get back the same shape regardless of which
 * provider actually answered, and re-validate every field themselves (this
 * layer only proves the response is well-formed JSON, never that it's
 * semantically correct).
 */
@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);
  private readonly geminiApiKey: string;
  private readonly geminiModel: string;
  private readonly openRouterApiKey: string;
  private readonly forceFailure: string;

  private geminiFailCount = 0;
  private geminiOpenUntil = 0;

  constructor(private readonly config: ConfigService) {
    this.geminiApiKey = this.config.get<string>('GEMINI_API_KEY') ?? '';
    this.geminiModel = this.config.get<string>('GEMINI_MODEL') ?? 'gemini-3.6-flash';
    this.openRouterApiKey = this.config.get<string>('OPENROUTER_API_KEY') ?? '';
    // TEST ONLY — see .env.example. Must never be set in a deployed environment.
    this.forceFailure = this.config.get<string>('AI_FORCE_FAILURE') ?? '';
  }

  get enabled(): boolean {
    return this.geminiApiKey.length > 0 || this.openRouterApiKey.length > 0;
  }

  async getStructuredIntent(req: StructuredIntentRequest): Promise<StructuredIntentResult> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (this.geminiApiKey) {
      if (this.geminiCircuitOpen()) {
        this.logger.debug('[ai-provider] provider=gemini skipped reason=circuit-open');
      } else {
        const started = Date.now();
        try {
          const raw = await this.callGemini(req, timeoutMs);
          this.geminiFailCount = 0;
          this.logger.log(`[ai-provider] provider=gemini result=ok ms=${Date.now() - started}`);
          return { raw, provider: 'gemini' };
        } catch (err) {
          this.recordGeminiFailure(err, Date.now() - started);
        }
      }
    }

    for (const provider of ['openrouter-nemotron-super', 'openrouter-nemotron-ultra'] as const) {
      if (!this.openRouterApiKey) break;
      const started = Date.now();
      try {
        const raw = await this.callOpenRouter(OPENROUTER_MODELS[provider], req, timeoutMs);
        this.logger.log(
          `[ai-provider] provider=${provider} result=ok ms=${Date.now() - started} fallback=true`,
        );
        return { raw, provider };
      } catch (err) {
        this.logFailure(provider, err, Date.now() - started);
      }
    }

    throw new AiUnavailableError();
  }

  private geminiCircuitOpen(): boolean {
    return Date.now() < this.geminiOpenUntil;
  }

  private recordGeminiFailure(err: unknown, ms: number): void {
    this.logFailure('gemini', err, ms);
    this.geminiFailCount += 1;
    if (this.geminiFailCount >= CIRCUIT_FAILURE_THRESHOLD) {
      this.geminiOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
      this.geminiFailCount = 0;
      this.logger.warn(
        `[ai-provider] provider=gemini circuit-open for ${CIRCUIT_OPEN_MS / 1000}s after ${CIRCUIT_FAILURE_THRESHOLD} consecutive failures`,
      );
    }
  }

  private logFailure(provider: AiProviderName, err: unknown, ms: number): void {
    const failure = err instanceof AiCallFailure ? err : new AiCallFailure(String(err));
    if (failure.status === 401 || failure.status === 403) {
      this.logger.error(
        `[ai-provider] provider=${provider} AUTH FAILURE (status ${failure.status}) — check the API key configuration`,
      );
      return;
    }
    this.logger.warn(
      `[ai-provider] provider=${provider} result=fail ms=${ms} reason=${failure.message} -> falling back`,
    );
  }

  private async callGemini(req: StructuredIntentRequest, timeoutMs: number): Promise<string> {
    if (this.forceFailure === 'gemini') {
      // TEST ONLY (see .env.example AI_FORCE_FAILURE) — never true in production.
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
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': this.geminiApiKey,
            },
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
        const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof raw !== 'string' || !raw.trim()) throw new AiCallFailure('empty response');
        extractJson(raw); // throws if not valid JSON — triggers fallback rather than handing the caller garbage
        return raw;
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

  private async callOpenRouter(
    model: string,
    req: StructuredIntentRequest,
    timeoutMs: number,
  ): Promise<string> {
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
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: req.systemPrompt + schemaHint },
            { role: 'user', content: req.userPrompt },
          ],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new AiCallFailure(`HTTP ${res.status}`, res.status);
      const json = await res.json();
      const raw = json?.choices?.[0]?.message?.content;
      if (typeof raw !== 'string' || !raw.trim()) throw new AiCallFailure('empty response');
      extractJson(raw);
      return raw;
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof AiCallFailure) throw err;
      if ((err as { name?: string }).name === 'AbortError') throw new AiCallFailure('timeout');
      if (err instanceof SyntaxError) throw new AiCallFailure('unparseable JSON');
      throw new AiCallFailure(String(err));
    }
  }
}
