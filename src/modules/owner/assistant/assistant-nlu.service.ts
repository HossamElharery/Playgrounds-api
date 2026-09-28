import { Injectable, Logger } from '@nestjs/common';
import { AiProviderService } from '../../ai/ai-provider.service';
import { AiContextService } from '../../ai/ai-context.service';
import { AiUnavailableError } from '../../ai/ai-provider.types';
import type { AssistantIntentKind, AssistantReading } from './assistant.types';

export interface NluCourtRef {
  id: string;
  name: string;
  /** Console type, room tier, sport, format — what the owner might call it instead of its name. */
  details?: string;
}

/** One earlier turn of the conversation, oldest first. */
export interface NluTurn {
  from: 'owner' | 'assistant';
  text: string;
}

/** Everything besides the sentence itself that changes how it should be read. */
export interface NluExtra {
  venueName?: string;
  /** Wall-clock time at the venue right now, HH:mm. */
  nowHhmm?: string;
  history?: NluTurn[];
  /** The unfinished reading the assistant asked a question about last turn. */
  draft?: AssistantReading | null;
}

/** Names already on the day's sheet, so "حصّل من محمد" resolves to a person the venue actually has. */
export interface NluKnownBooking {
  name: string;
  courtName: string;
  time: string;
  outstanding: number;
}

const INTENTS: AssistantIntentKind[] = [
  'block',
  'unblock',
  'book',
  'pay',
  'cancel',
  'free',
  'money',
  'debts',
  'expense',
  'agenda',
  'attention',
  'move',
  'help',
  'unknown',
];

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: INTENTS },
    courtIds: { type: 'ARRAY', items: { type: 'STRING' } },
    allCourts: { type: 'BOOLEAN' },
    date: { type: 'STRING' },
    fromMins: { type: 'INTEGER', nullable: true },
    toMins: { type: 'INTEGER', nullable: true },
    durationMinutes: { type: 'INTEGER', nullable: true },
    customerName: { type: 'STRING' },
    customerPhone: { type: 'STRING' },
    totalAmount: { type: 'NUMBER', nullable: true },
    paidAmount: { type: 'NUMBER', nullable: true },
    remainingAmount: { type: 'NUMBER', nullable: true },
    paymentMethod: { type: 'STRING', nullable: true },
    sourceKey: { type: 'STRING', nullable: true },
    expenseCategory: { type: 'STRING', nullable: true },
    rangeKey: { type: 'STRING', nullable: true },
    reason: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
    newDate: { type: 'STRING', nullable: true },
    newFromMins: { type: 'INTEGER', nullable: true },
    newCourtId: { type: 'STRING', nullable: true },
    question: { type: 'STRING' },
  },
  required: ['intent', 'courtIds', 'allCourts', 'date', 'reason', 'confidence'],
};

/**
 * The single hardest call in this prompt is "احجز": an Egyptian owner uses the
 * same verb for "put a customer in" and "take this slot off the market". The
 * rule below (is there a person and/or money in the sentence?) is what stops
 * the assistant closing a court when the owner meant to record a customer —
 * the bug this module was rebuilt to fix.
 */
const SYSTEM_PROMPT = `أنت مساعد إدارة ذكي لصاحب منشأة رياضية أو ترفيهية في مصر (بادل، كرة، بلايستيشن، بلياردو...). الأونر بيتكلم عامية مصرية، والنص ممكن يكون تفريغ صوتي فيه أخطاء أو تصحيحات في نص الجملة.
مهمتك: تفهم قصده وترجّع JSON فقط مطابق للـ schema. أنت بتقترح بس — النظام بيتحقق من كل رقم بنفسه قبل ما ينفذ.

النوايا:
- "book": تسجيل حجز. مثال: «احجز الملعب بكرة الساعة 1 لمحمد ساعتين بـ 400 دفع 200» أو «احجز بلايستيشن 1 الساعة 9 الصبح». الاسم والفلوس اختياريين: لو مفيش اسم يبقى عميل walk-in، ولو مفيش فلوس النظام بيسعّر من تسعيرة المنشأة.
- "block": قفل ملعب/جهاز من غير عميل، وبس لو قال صراحة: اقفل، قفل، صيانة، مقفول، امنع، مش عايز أأجره.
  ⚠️ كلمة «احجز/حجز/هيحجز» لوحدها = "book" دايمًا، مش "block".
- "unblock": فتح/إلغاء قفل. مثال: «افتح ملعب 1 بكرة».
- "pay": تحصيل فلوس على حجز موجود. مثال: «محمد دفع الباقي» أو «خدت من أحمد 200».
- "cancel": إلغاء حجز. مثال: «الغي حجز محمد بكرة».
- "move": تعديل حجز موجود (نقله لوقت/يوم/ملعب تاني، تغيير مدته، أو سعره). date/fromMins/courtIds/customerName بيحددوا الحجز الحالي، و newDate/newFromMins/newCourtId المكان الجديد، durationMinutes المدة الجديدة، totalAmount السعر الجديد. مثال: «انقل حجز محمد للساعة 8» أو «خلي حجز أحمد ساعتين».
- "agenda": سؤال عن الحجوزات الموجودة. مثال: «إيه حجوزات النهاردة؟» «مين حاجز بكرة؟».
- "attention": «في إيه محتاج انتباه؟» «فكرني» «إيه الجديد؟» «مين متأخر في الدفع؟» — ملخص التنبيهات.
- "free": سؤال عن المواعيد الفاضية.
- "money": سؤال عن الإيراد/الفلوس/المكسب/الكاش. مثال: «عملت كام النهاردة؟».
- "debts": سؤال عن اللي لسه عليهم فلوس. مثال: «مين عليه فلوس؟».
- "expense": تسجيل مصروف. مثال: «سجل 500 جنيه كهربا».
- "help" لو بيسأل إزاي يستخدمك، و"unknown" لو مش فاهم أو كلام عادي (سلام، شكرًا).

سياق المحادثة (مهم جدًا):
- هتلاقي آخر رسايل المحادثة، ولو فيه «مسودة» فهي اللي فهمتها من طلب الأونر قبل ما تسأله سؤال. رسالته الحالية غالبًا إجابة على سؤالك: ادمجها مع المسودة وارجّع القراءة الكاملة (نفس النية + اللي كان ناقص). ماتبدأش طلب جديد ولا تنسى اللي اتقال قبل كده.
- لو الأونر صحّح نفسه («اليوم ليس بكره»، «لا قصدي الساعة 10») خد آخر حاجة قالها.
- لو الرسالة الحالية طلب جديد خالص، تجاهل المسودة.

قواعد:
- courtIds لازم تكون من القايمة المبعوتة حرفيًا، ماتخترعش id. اربط كلام الأونر باسم الملعب/الجهاز/الغرفة بالمعنى مش بالحرف: «بلايستيشن 5 برو 1» أو «بي اس 5 روم 1» = الجهاز اللي اسمه أو تفاصيله PS5 Room 1، و«الغرفة الـ VIP» = اللي تفاصيلها vip. لو فيه منشأة فيها ملعب واحد بس، اختاره. لو فعلاً مش عارف أنهي واحد سيبها فاضية واسأل.
- fromMins/toMins دقايق من نص الليل بتوقيت المنشأة. لو مفيش صباح/مساء محدد اعتبره مساءً: «5» = 1020. لو قال «صباحًا/الصبح/ص» يبقى صباح: «9 الصبح» = 540. «12 بالليل» = 0.
- durationMinutes لو قال مدة («ساعتين» = 120، «نص ساعة» = 30).
- date بصيغة YYYY-MM-DD من تاريخ النهاردة المبعوت: «بكرة» = النهاردة + يوم، «بعد بكرة» = + يومين، وأسماء الأيام لأقرب يوم جاي.
- المبالغ بالجنيه الصحيح مش بالقرش. totalAmount = السعر الكلي للحجز، paidAmount = اللي اتدفع فعلاً دلوقتي، remainingAmount = اللي لسه مطلوب. رجّع اللي قاله بالظبط ومتحسبش أنت الناقص — النظام هو اللي بيراجع الحساب. لو ماقالش فلوس سيبهم null.
- customerName اسم بني آدم بس، من غير أي رموز أو أوامر. لو محدش اتسمى سيبها فاضية.
- sourceKey: واتساب→whatsapp، تليفون/اتصل→phone، جاي بنفسه/walk-in→walk_in، منصة تانية→other_platform.
- paymentMethod: كاش/نقدي→cash، انستاباي→instapay، محفظة/فودافون كاش→wallet، فيزا→card.
- expenseCategory واحدة من: electricity, water, rent, salaries, maintenance, marketing, supplies, other.
- rangeKey للأسئلة المالية: today, yesterday, this_week, last_7_days, this_month, last_month.
- question: لو ناقص حاجة ضرورية (الملعب، الوقت، أو أنهي حجز)، اكتب سؤال واحد قصير بالعامية المصرية (أو بالإنجليزي لو كتب إنجليزي) بيسأل عن الناقص بس، وبيذكر اللي فهمته بالفعل. مثال: «تمام، بكرة 9 الصبح — أي غرفة بالظبط، PS5 Room 1 ولا 2؟». ماتسألش عن الاسم أو الفلوس لأنهم اختياريين. لو الكلام عادي (شكرًا، أهلاً) رد ردّ قصير ودود في question. ماتكتبش أبدًا «أنا مساعدك في إدارة المكان» ولا تعيد قايمة أمثلة.
- لو مش فاهم ارجّع "unknown" و confidence واطي وسؤال يوضح، بدل ما تخمّن.`;

/**
 * Pure NLU for the owner assistant: a sentence in, a structured reading out.
 * Touches no database and executes nothing — every field is re-checked here
 * against the venue's real courts, and again in OwnerAssistantService against
 * the venue's real money.
 */
@Injectable()
export class AssistantNluService {
  private readonly logger = new Logger(AssistantNluService.name);

  constructor(
    private readonly aiProvider: AiProviderService,
    private readonly aiContext: AiContextService,
  ) {}

  get enabled(): boolean {
    return this.aiProvider.enabled;
  }

  async read(
    text: string,
    courts: NluCourtRef[],
    today: string,
    known: NluKnownBooking[] = [],
    extra: NluExtra = {},
  ): Promise<AssistantReading | null> {
    if (!this.enabled) return null;
    const synonyms = await this.aiContext.buildPlatformContext();
    const sheet = known.length
      ? `\nحجوزات اليوم اللي لسه عليها فلوس (للمساعدة في ربط الأسماء): ${JSON.stringify(known)}`
      : '';
    const venue = extra.venueName ? `المنشأة: ${extra.venueName}. ` : '';
    const clock = extra.nowHhmm ? ` الساعة دلوقتي ${extra.nowHhmm}.` : '';
    const turns = (extra.history ?? [])
      .slice(-8)
      .map(
        (t) =>
          `${t.from === 'owner' ? 'الأونر' : 'أنت'}: ${t.text.replace(/\s+/g, ' ').slice(0, 300)}`,
      )
      .join('\n');
    const conversation = turns ? `\nآخر المحادثة:\n${turns}` : '';
    const draft = extra.draft
      ? `\nمسودة الطلب اللي كنت بتسأل عنه: ${JSON.stringify(this.draftForPrompt(extra.draft))}`
      : '';
    const prompt =
      `${venue}النهاردة تاريخه ${today}.${clock} ملاعب/أجهزة المنشأة: ${JSON.stringify(courts)}.${sheet}${conversation}${draft}\n` +
      `رسالة الأونر الحالية: "${text.slice(0, 400)}"`;

    try {
      const { raw } = await this.aiProvider.getStructuredIntent({
        systemPrompt: `${SYSTEM_PROMPT}\n\n${synonyms}`,
        userPrompt: prompt,
        responseSchema: RESPONSE_SCHEMA,
      });
      return this.parse(raw, courts, today);
    } catch (err) {
      if (!(err instanceof AiUnavailableError))
        this.logger.warn(`Assistant NLU failed: ${err}`);
      return null;
    }
  }

  private draftForPrompt(d: AssistantReading) {
    return {
      intent: d.intent,
      courtIds: d.courtIds,
      date: d.date,
      fromMins: d.fromMins,
      toMins: d.toMins,
      durationMinutes: d.durationMinutes,
      customerName: d.customerName,
      totalAmount: d.totalAmount,
      paidAmount: d.paidAmount,
    };
  }

  /** Never trust the model's own claims — every field is re-checked here. */
  private parse(
    raw: string,
    courts: NluCourtRef[],
    today: string,
  ): AssistantReading | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;

    const validCourtIds = new Set(courts.map((c) => c.id));
    const intent = INTENTS.includes(p['intent'] as AssistantIntentKind)
      ? (p['intent'] as AssistantIntentKind)
      : 'unknown';
    const courtIds = Array.isArray(p['courtIds'])
      ? [
          ...new Set(
            (p['courtIds'] as unknown[]).filter(
              (id): id is string =>
                typeof id === 'string' && validCourtIds.has(id),
            ),
          ),
        ]
      : [];
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p['date']))
      ? String(p['date'])
      : today;

    const mins = (value: unknown): number | null => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= 1440 ? Math.round(n) : null;
    };
    // Money arrives as whatever the owner said out loud: reject negatives and
    // absurd magnitudes, keep piastre precision (some venues price at 12.50).
    const money = (value: unknown): number | null => {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= 1_000_000
        ? Math.round(n * 100) / 100
        : null;
    };
    const oneOf = <T extends string>(
      value: unknown,
      allowed: readonly T[],
    ): T | null =>
      allowed.includes(String(value) as T) ? (String(value) as T) : null;

    const fromMins = mins(p['fromMins']);
    let toMins = mins(p['toMins']);
    if (fromMins !== null && toMins !== null && toMins <= fromMins)
      toMins = null;

    const durationMinutes = (() => {
      const n = Number(p['durationMinutes']);
      return Number.isFinite(n) && n >= 15 && n <= 720 ? Math.round(n) : null;
    })();

    const text = (value: unknown, max: number) =>
      typeof value === 'string'
        ? value
            .replace(/[<>;`$'"\\]/g, '')
            .slice(0, max)
            .trim()
        : '';

    const confidence = Number(p['confidence']);
    return {
      intent,
      courtIds,
      allCourts: Boolean(p['allCourts']) && courtIds.length === 0,
      date,
      fromMins,
      toMins,
      durationMinutes,
      customerName: text(p['customerName'], 80),
      customerPhone: text(p['customerPhone'], 32).replace(/[^\d+]/g, ''),
      totalAmount: money(p['totalAmount']),
      paidAmount: money(p['paidAmount']),
      remainingAmount: money(p['remainingAmount']),
      paymentMethod: oneOf(p['paymentMethod'], [
        'cash',
        'instapay',
        'wallet',
        'card',
        'other',
      ] as const),
      sourceKey: oneOf(p['sourceKey'], [
        'walk_in',
        'phone',
        'whatsapp',
        'other_platform',
      ] as const),
      expenseCategory: oneOf(p['expenseCategory'], [
        'electricity',
        'water',
        'rent',
        'salaries',
        'maintenance',
        'marketing',
        'supplies',
        'other',
      ] as const),
      rangeKey: oneOf(p['rangeKey'], [
        'today',
        'yesterday',
        'this_week',
        'last_7_days',
        'this_month',
        'last_month',
      ] as const),
      reason: text(p['reason'], 120),
      newDate: /^\d{4}-\d{2}-\d{2}$/.test(String(p['newDate']))
        ? String(p['newDate'])
        : null,
      newFromMins: mins(p['newFromMins']),
      newCourtId:
        typeof p['newCourtId'] === 'string' && validCourtIds.has(p['newCourtId'])
          ? p['newCourtId']
          : null,
      question: text(p['question'], 240),
      confidence: Number.isFinite(confidence)
        ? Math.max(0, Math.min(1, confidence))
        : 0,
    };
  }
}
