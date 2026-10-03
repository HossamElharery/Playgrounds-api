import { Injectable, Logger } from '@nestjs/common';
import { AiProviderService } from '../../ai/ai-provider.service';
import { AiContextService } from '../../ai/ai-context.service';
import { AiUnavailableError } from '../../ai/ai-provider.types';
import {
  CAPTAIN_INTENTS,
  type CaptainFilters,
  type CaptainIntent,
  type CaptainReading,
} from './captain.types';
import { plainLine } from './captain-text';
import type { KnowledgeEntry } from './captain-knowledge';

export interface CaptainTurn {
  from: 'player' | 'captain';
  text: string;
}

export interface CaptainNluInput {
  text: string;
  lang: 'ar' | 'en';
  loggedIn: boolean;
  hasCoords: boolean;
  history: CaptainTurn[];
  /** Filters of the search the player is looking at right now, if any. */
  context: CaptainFilters | null;
  /** The platform facts Captain is allowed to answer from, so the model can name the ones that apply. */
  knowledge: KnowledgeEntry[];
  /** Admin tools only: ask exactly these models, and do not stop for a spent daily budget. */
  modelsOverride?: string[];
  skipBudget?: boolean;
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: CAPTAIN_INTENTS },
    sport: { type: 'STRING', nullable: true },
    district: { type: 'STRING', nullable: true },
    nearMe: { type: 'BOOLEAN' },
    cheap: { type: 'BOOLEAN' },
    priceMax: { type: 'NUMBER', nullable: true },
    minRating: { type: 'NUMBER', nullable: true },
    instantOnly: { type: 'BOOLEAN' },
    sort: { type: 'STRING', enum: ['rating', 'price', 'distance', 'none'] },
    timeHint: { type: 'STRING', enum: ['now', 'tonight', 'tomorrow', 'none'] },
    followUp: { type: 'BOOLEAN' },
    topic: { type: 'STRING' },
    factIds: { type: 'ARRAY', items: { type: 'STRING' } },
    reply: { type: 'STRING' },
    question: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
  },
  required: ['intent', 'nearMe', 'cheap', 'instantOnly', 'followUp', 'confidence'],
};

const SYSTEM_PROMPT = `أنت "كابتن"، مساعد تطبيق ماتشنا للاعبين في مصر (حجز ملاعب كورة وبادل وإسكواش وبلايستيشن وبلياردو، ولاقي لاعبين تلعب معاهم). اللاعب بيكتب أو بيتكلم بالعامية المصرية أو الإنجليزي، والنص ممكن يكون تفريغ صوتي فيه أخطاء.
مهمتك بس: تفهم قصده وترجّع JSON مطابق للـ schema. أنت مش بتكتب إجابات عن الأماكن ولا الأسعار — النظام بيجيب الحقايق الحقيقية بنفسه. أنت بتصنّف وتستخرج.

النوايا:
- find_venues: بيدور على ملعب/مكان يلعب فيه (أي صيغة: «عايز بادل في المعادي»، «في حاجة رخيصة؟»، «أحسن ملعب كورة»، «حاجة قريبة»).
- my_bookings: بيسأل عن حجوزاته هو («حجوزاتي»، «عندي حجز إمتى؟»، «حجزي بكرة الساعة كام»).
- faq: سؤال عن ماتشنا نفسها: إزاي الحجز/الدفع/الإلغاء/الاسترداد/الحساب بيشتغل، أو اللوبي والسكواد والأصحاب. اختار في factIds رقم أو اتنين من «حقائق المنصة» اللي بتجاوب السؤال حرفيًا (ماتخترعش id)، وحط في topic كلمات مفتاحية قصيرة. لو مفيش حقيقة مناسبة سيب factIds فاضية.
- players: بيدور على ناس تلعب معاه أو أصحاب. chat: عايز يراسل حد. community: فرق/سكواد/مجتمع. tonight: خطط الليلة. help: عايز يفتح مركز المساعدة بشكل عام. (لو عايز يتواصل مع الدعم أو يشتكي أو يعترض على استرداد فده faq واختار support_contact.) login: تسجيل دخول. explore: عايز يتصفح كل الأماكن.
- smalltalk: تحية أو شكر أو «عامل إيه» بس؛ اكتب في reply ردّ قصير ودود (جملة واحدة) وماتوعدش بحاجة التطبيق مش بيعملها. أي سؤال عام أو أخبار أو نتايج ماتشات أو معلومات خارج ماتشنا (سياسة، رياضة عالمية، إلخ) مش smalltalk: ده unknown، واكتب في question: «أنا كابتن ماتشنا وبساعدك في الملاعب والحجز واللوبي. تحب أدورلك على ملعب؟» ماتجاوبش على السؤال نفسه أبدًا.
- unknown: مش فاهم، واكتب في question سؤال واحد قصير يوضح الناقص.

قواعد:
- sport و district: من الـ slugs المبعوتة حرفيًا بس؛ لو مش متأكد رجّع null، ماتخترعش.
- cheap لو قال رخيص/اقتصادي/أرخص. priceMax بالجنيه لو ذكر سقف («تحت 300»، «ميزانيتي 200»). minRating (من 5) لو قال «حلو/ممتاز/تقييم عالي» ≈ 4.
- instantOnly لو عايز «حجز فوري/أحجز دلوقتي من غير انتظار». sort: «الأرخص»=price، «الأحسن/الأعلى تقييم»=rating، «الأقرب»=distance، وإلا none.
- timeHint: دلوقتي=now، الليلة/النهاردة بالليل=tonight، بكرة=tomorrow.
- nearMe لو قال قريب مني/جنبي/حواليا.
- followUp=true لو الجملة بتعدّل البحث اللي قدامه («أرخص من كده»، «وفي المعادي؟»، «بادل بدل كورة»، «اللي فيه حجز فوري»)، وسيب في الحقول اللي اتغيرت بس. لو طلب جديد خالص، followUp=false.
- لو بيسأل عن حجوزاته أو بيعمل حاجة محتاجة تسجيل دخول واللاعب مش مسجل، برضه ارجع النية الصح (النظام هو اللي بيقوله يسجل).
- لو الكلام مش واضح ارجّع unknown و confidence واطي بدل ما تخمّن.`;

const SORTS = ['rating', 'price', 'distance'] as const;
const TIMES = ['now', 'tonight', 'tomorrow'] as const;

/**
 * Sentence in, structured reading out. Never touches the database or executes
 * anything; every field is re-checked against the real catalogue before use.
 */
@Injectable()
export class CaptainNluService {
  private readonly logger = new Logger(CaptainNluService.name);

  constructor(
    private readonly aiProvider: AiProviderService,
    private readonly aiContext: AiContextService,
  ) {}

  get enabled(): boolean {
    return this.aiProvider.enabled;
  }

  /** null = no model reachable (the caller falls back to keyword matching). */
  async read(input: CaptainNluInput): Promise<CaptainReading | null> {
    if (!this.enabled) return null;
    const platform = await this.aiContext.buildPlatformContext();
    const turns = input.history
      .slice(-6)
      .map((t) => `${t.from === 'player' ? 'اللاعب' : 'كابتن'}: ${t.text.replace(/\s+/g, ' ').slice(0, 200)}`)
      .join('\n');
    const facts = input.knowledge.map((k) => `${k.id}: ${k.topicAr}`).join('\n');
    const prompt =
      `حقائق المنصة (اختار منها بالـ id بس):\n${facts}\n\n` +
      `اللاعب ${input.loggedIn ? 'مسجل دخول' : 'زائر (مش مسجل)'}. ` +
      `${input.hasCoords ? 'موقعه متاح.' : 'موقعه مش متاح.'} لغة الواجهة: ${input.lang}.\n` +
      (input.context
        ? `البحث الحالي قدامه (فلاتر): ${JSON.stringify(input.context)}\n`
        : '') +
      (turns ? `آخر المحادثة:\n${turns}\n` : '') +
      `رسالته الحالية: "${input.text.slice(0, 300)}"`;

    try {
      const { raw, model, ms, costUsd } = await this.aiProvider.getStructuredIntent({
        systemPrompt: `${SYSTEM_PROMPT}\n\n${platform}`,
        userPrompt: prompt,
        responseSchema: RESPONSE_SCHEMA,
        profile: 'public',
        reasoning: 'minimal',
        cacheTtlMs: input.modelsOverride?.length ? undefined : 120_000,
        modelsOverride: input.modelsOverride,
        skipBudget: input.skipBudget,
      });
      const reading = await this.parse(raw, new Set(input.knowledge.map((k) => k.id)));
      return reading ? { ...reading, meta: { model, ms, costUsd } } : null;
    } catch (err) {
      if (!(err instanceof AiUnavailableError)) this.logger.warn(`Captain NLU failed: ${err}`);
      return null;
    }
  }

  /** Never trust the model's own claims — every field is re-checked here. */
  private async parse(raw: string, factIds: Set<string>): Promise<CaptainReading | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    const { sports, districts } = await this.aiContext.listValidSlugs();

    const intent: CaptainIntent = CAPTAIN_INTENTS.includes(p['intent'] as CaptainIntent)
      ? (p['intent'] as CaptainIntent)
      : 'unknown';
    const num = (v: unknown, min: number, max: number): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= min && n <= max ? n : null;
    };
    const confidence = Number(p['confidence']);
    return {
      intent,
      sport: typeof p['sport'] === 'string' && sports.has(p['sport']) ? p['sport'] : null,
      district:
        typeof p['district'] === 'string' && districts.has(p['district']) ? p['district'] : null,
      nearMe: p['nearMe'] === true,
      cheap: p['cheap'] === true,
      priceMax: num(p['priceMax'], 10, 100_000),
      minRating: num(p['minRating'], 1, 5),
      instantOnly: p['instantOnly'] === true,
      sort: SORTS.includes(p['sort'] as (typeof SORTS)[number])
        ? (p['sort'] as (typeof SORTS)[number])
        : null,
      timeHint: TIMES.includes(p['timeHint'] as (typeof TIMES)[number])
        ? (p['timeHint'] as (typeof TIMES)[number])
        : null,
      followUp: p['followUp'] === true,
      topic: plainLine(p['topic'], 80),
      factIds: Array.isArray(p['factIds'])
        ? [...new Set((p['factIds'] as unknown[]).filter((id): id is string => typeof id === 'string' && factIds.has(id)))].slice(0, 2)
        : [],
      reply: plainLine(p['reply'], 220),
      question: plainLine(p['question'], 200),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    };
  }
}
