import { Injectable, Logger } from '@nestjs/common';
import { AiProviderService } from '../ai/ai-provider.service';
import { AiContextService } from '../ai/ai-context.service';
import { AiUnavailableError } from '../ai/ai-provider.types';

export interface NluCourtRef {
  id: string;
  name: string;
}

export interface NluResult {
  intent: 'block' | 'unblock' | 'free' | 'unknown';
  courtIds: string[];
  allCourts: boolean;
  date: string;
  fromMins: number | null;
  toMins: number | null;
  reason: string;
  confidence: number;
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: ['block', 'unblock', 'free', 'unknown'] },
    courtIds: { type: 'ARRAY', items: { type: 'STRING' } },
    allCourts: { type: 'BOOLEAN' },
    date: { type: 'STRING' },
    fromMins: { type: 'INTEGER', nullable: true },
    toMins: { type: 'INTEGER', nullable: true },
    reason: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
  },
  required: ['intent', 'courtIds', 'allCourts', 'date', 'reason', 'confidence'],
};

const SYSTEM_PROMPT = `أنت محلل نوايا لجدول ملعب رياضي مصري (بادل، كرة قدم، بلايستيشن، بلياردو...). العامية المصرية والفصحى مقبولة، والنص ممكن يكون نسخة صوت لصوت-نص فيها أخطاء بسيطة.
رجّع JSON فقط يطابق الـ schema بالظبط. اختَر courtIds من القايمة اللي هتتبعتلك حرفيًا بالـ id بتاعها — ماتخترعش IDs جديدة ولا تخمّن كورت مش في القايمة (لو مش متأكد اترك courtIds فاضية و allCourts false).
لو مفيش وقت صباح/مساء محدد اعتبره مساءً لأن الملاعب بتشتغل بالليل. fromMins و toMins عدد الدقايق من نص الليل لنفس اليوم (مثال: 5 مساءً = 1020، 9 صباحًا = 540).
intent يبقى "block" للقفل/الحجز اليدوي/منصة تانية/صيانة، "unblock" للفتح/الإلغاء، "free" لو بيسأل عن المتاح بس من غير ما يطلب تغيير، و"unknown" لو مش قادر تفهم قصده.
لو الجملة مش واضحة خالص رجّع intent "unknown" و confidence واطي بدل ما تخمّن.`;

/**
 * Pure NLU: turns a spoken/typed sentence into a structured intent. Never
 * touches the database and never executes anything — the caller re-validates
 * every field (real court ids, sane date/time bounds) before acting on it.
 * The actual model call (Gemini, with OpenRouter fallback) lives behind
 * AiProviderService — this service never talks to a provider directly.
 */
@Injectable()
export class GeminiNluService {
  private readonly logger = new Logger(GeminiNluService.name);

  constructor(
    private readonly aiProvider: AiProviderService,
    private readonly aiContext: AiContextService,
  ) {}

  get enabled(): boolean {
    return this.aiProvider.enabled;
  }

  async interpret(
    text: string,
    courts: NluCourtRef[],
    today: string,
  ): Promise<NluResult | null> {
    if (!this.enabled) return null;
    const synonyms = await this.aiContext.buildPlatformContext();
    const prompt =
      `النهاردة تاريخه ${today}. الملاعب المتاحة في المنشأة دي: ` +
      `${JSON.stringify(courts)}. الأونر قال: "${text.slice(0, 400)}"`;

    try {
      const { raw } = await this.aiProvider.getStructuredIntent({
        systemPrompt: `${SYSTEM_PROMPT}\n\n${synonyms}`,
        userPrompt: prompt,
        responseSchema: RESPONSE_SCHEMA,
      });
      return this.parseModelJson(raw, courts);
    } catch (err) {
      if (!(err instanceof AiUnavailableError)) this.logger.warn(`Schedule NLU call failed: ${err}`);
      return null;
    }
  }

  /** Never trust the model's own claims — every field is re-checked here. */
  private parseModelJson(raw: string, courts: NluCourtRef[]): NluResult | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;

    const validCourtIds = new Set(courts.map((c) => c.id));
    const intent = ['block', 'unblock', 'free', 'unknown'].includes(p['intent'] as string)
      ? (p['intent'] as NluResult['intent'])
      : 'unknown';
    const courtIds = Array.isArray(p['courtIds'])
      ? (p['courtIds'] as unknown[]).filter(
          (id): id is string => typeof id === 'string' && validCourtIds.has(id),
        )
      : [];
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p['date'])) ? String(p['date']) : '';
    const clampMins = (value: unknown): number | null => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= 1440 ? Math.round(n) : null;
    };
    let fromMins = clampMins(p['fromMins']);
    let toMins = clampMins(p['toMins']);
    if (fromMins !== null && toMins !== null && toMins <= fromMins) {
      toMins = null; // contradictory range — let the caller ask again rather than guess
    }
    const reason = typeof p['reason'] === 'string' ? p['reason'].slice(0, 120) : '';
    const confidence = Number(p['confidence']);

    if (!date) return null;
    return {
      intent,
      courtIds,
      allCourts: Boolean(p['allCourts']) && courtIds.length === 0,
      date,
      fromMins,
      toMins,
      reason,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    };
  }
}
