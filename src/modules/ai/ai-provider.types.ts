/**
 * Who is asking decides where the sentence may travel.
 *  - `owner`: the venue owner's assistant. Its prompts can carry customer
 *    names and amounts, so it only ever goes to Google models.
 *  - `public`: players and visitors (Captain, smart search). Search intent
 *    only, no personal data, so cheaper or free fallbacks are acceptable.
 */
export type AiProfile = 'owner' | 'public';

export type AiProviderName = 'openrouter' | 'gemini';

export type AiReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface StructuredIntentRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Gemini-native JSON schema; the OpenRouter models get it as prompt text instead. */
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
  /** Defaults to `owner` — the most private route — so a caller must opt in to the wider one. */
  profile?: AiProfile;
  /** How long the model may think. Thinking tokens are billed as output. */
  reasoning?: AiReasoningEffort;
  /** Identical prompts inside this window reuse the previous answer. */
  cacheTtlMs?: number;
  /**
   * Admin tools only (live preview, quality runs, shadow comparison): ask exactly
   * these OpenRouter models, in order, instead of the audience's chain. Public
   * profile only — the owner assistant never leaves its own chain.
   */
  modelsOverride?: string[];
  /** Admin tools only: the call is real and still counted, but a spent daily budget does not stop an admin from testing. */
  skipBudget?: boolean;
}

export interface StructuredIntentResult {
  /** Normalised JSON text — the caller still re-validates every field. */
  raw: string;
  provider: AiProviderName;
  model: string;
  costUsd: number;
  ms: number;
}

/** Thrown when every route failed or the day's AI budget is spent. Callers must catch this. */
export class AiUnavailableError extends Error {
  constructor(
    message = 'AI_UNAVAILABLE',
    readonly reason: 'unavailable' | 'budget' = 'unavailable',
  ) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}
