export type AiProfile = 'owner' | 'public';

export type AiProviderName = 'openrouter' | 'gemini';

export type AiReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface StructuredIntentRequest {
  systemPrompt: string;
  userPrompt: string;
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
  profile?: AiProfile;
  reasoning?: AiReasoningEffort;
  cacheTtlMs?: number;
  modelsOverride?: string[];
  skipBudget?: boolean;
}

export interface StructuredIntentResult {
  raw: string;
  provider: AiProviderName;
  model: string;
  costUsd: number;
  ms: number;
}

export class AiUnavailableError extends Error {
  constructor(
    message = 'AI_UNAVAILABLE',
    readonly reason: 'unavailable' | 'budget' = 'unavailable',
  ) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}
