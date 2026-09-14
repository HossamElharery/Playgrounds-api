// NOTE: OpenRouter's free-tier lineup changes over time — meta-llama/qwen
// free models were retired by the time this was implemented (2026-09), so
// the fallback models here are two currently-free Nvidia Nemotron models
// (verified working via `npm run test:openrouter`). Re-check
// https://openrouter.ai/models?max_price=0 periodically and swap these out
// if they too get retired.
export type AiProviderName = 'gemini' | 'openrouter-nemotron-ultra' | 'openrouter-nemotron-super';

export interface StructuredIntentRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Gemini-native JSON schema (ignored by the OpenRouter fallbacks — they rely on the prompt text instead). */
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface StructuredIntentResult {
  /** Raw model text — the caller re-validates every field, exactly as before this layer existed. */
  raw: string;
  provider: AiProviderName;
}

/** Thrown when Gemini and both OpenRouter fallbacks all fail. Callers must catch this. */
export class AiUnavailableError extends Error {
  constructor(message = 'AI_UNAVAILABLE') {
    super(message);
    this.name = 'AiUnavailableError';
  }
}
