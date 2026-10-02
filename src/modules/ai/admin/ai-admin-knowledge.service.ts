import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiProviderService } from '../ai-provider.service';
import { AiUnavailableError } from '../ai-provider.types';
import { AssistantKnowledgeService } from '../knowledge/assistant-knowledge.service';
import { CaptainNluService } from '../../search/captain/captain-nlu.service';
import { bestFaq, plainLine } from '../../search/captain/captain-text';
import type { KnowledgeEntry } from '../knowledge/default-knowledge';
import { checkKnowledge, type KnowledgeInput } from '../knowledge/knowledge.validation';

export interface PreviewResult {
  /** A model read the sentence (false = the keyword fallback would have been used). */
  modelAnswered: boolean;
  intent: string | null;
  topic: string;
  factIds: string[];
  picked: { id: string; ar: string; en: string; cta: { target: string; labelAr: string; labelEn: string } | null }[];
  /** The draft entry (when one was given) is among the ones the model chose. */
  draftPicked: boolean;
  /** The draft is switched off for players in this deployment (its feature flag is off). */
  draftHiddenByFlag: boolean;
  /** With no knowledge entry chosen: the help-center FAQ Captain would fall back to, else nothing — "unanswered". */
  faqFallback: { id: string; questionAr: string; questionEn: string } | null;
  outcome: 'answered_fact' | 'answered_faq' | 'unanswered' | 'not_a_question';
  model: string | null;
  ms: number;
  costUsd: number;
}

export interface DraftResult {
  id: string;
  topicAr: string;
  topicEn: string;
  ar: string;
  en: string;
  model: string | null;
  note: 'topics_only' | 'translated';
}

/** The editor's helpers: ask-as-a-player preview, and AI-assisted drafting the admin always reviews. */
@Injectable()
export class AiAdminKnowledgeService {
  private readonly logger = new Logger(AiAdminKnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: AiProviderService,
    private readonly knowledge: AssistantKnowledgeService,
    private readonly nlu: CaptainNluService,
  ) {}

  /**
   * Runs a sentence through the real reading step against the live knowledge
   * (with the unsaved draft swapped in) and shows exactly what a player would see.
   */
  async preview(input: { text: string; lang?: 'ar' | 'en'; loggedIn?: boolean; draft?: KnowledgeInput }): Promise<PreviewResult> {
    const text = input.text.trim();
    if (text.length < 2 || text.length > 300) throw new BadRequestException('text must be 2-300 characters');
    const lang = input.lang ?? (/[؀-ۿ]/.test(text) ? 'ar' : 'en');

    let entries: KnowledgeEntry[] = await this.knowledge.entries();
    let draftId: string | null = null;
    if (input.draft) {
      const check = checkKnowledge(input.draft, { requireId: false });
      // An unfinished draft (a field still empty) cannot be previewed; say which.
      const v = check.value ?? this.looseDraft(input.draft);
      if (!v) throw new BadRequestException({ message: 'VALIDATION_FAILED', code: 'VALIDATION_FAILED', result: { errors: check.errors } });
      draftId = v.id;
      const entry: KnowledgeEntry = {
        id: v.id,
        topicAr: v.topicAr,
        topicEn: v.topicEn,
        ar: v.ar,
        en: v.en,
        cta: v.ctaTarget ? { target: v.ctaTarget, labelAr: v.ctaLabelAr ?? '', labelEn: v.ctaLabelEn ?? '' } : undefined,
        when: v.flag ?? undefined,
      };
      entries = v.active === false ? entries.filter((e) => e.id !== v.id) : [...entries.filter((e) => e.id !== v.id), entry];
    }
    const visible = this.knowledge.forDeployment(entries);
    const draftHiddenByFlag = !!draftId && entries.some((e) => e.id === draftId) && !visible.some((e) => e.id === draftId);

    const reading = await this.nlu.read({
      text,
      lang,
      loggedIn: input.loggedIn ?? true,
      hasCoords: false,
      history: [],
      context: null,
      knowledge: visible,
      skipBudget: true,
    });
    const known = new Map(visible.map((k) => [k.id, k]));
    const picked = (reading?.factIds ?? []).map((id) => known.get(id)).filter((k): k is KnowledgeEntry => !!k);

    let faqFallback: PreviewResult['faqFallback'] = null;
    if (reading && reading.intent === 'faq' && !picked.length) {
      const rows = await this.prisma.faqEntry.findMany({
        select: { id: true, questionAr: true, questionEn: true, answerAr: true, answerEn: true, ctaPath: true, ctaLabelAr: true, ctaLabelEn: true },
      });
      const hit = bestFaq(`${reading.topic} ${text}`, rows);
      faqFallback = hit ? { id: hit.id, questionAr: hit.questionAr, questionEn: hit.questionEn } : null;
    }
    const outcome: PreviewResult['outcome'] = !reading || reading.intent !== 'faq' ? 'not_a_question' : picked.length ? 'answered_fact' : faqFallback ? 'answered_faq' : 'unanswered';
    return {
      modelAnswered: !!reading,
      intent: reading?.intent ?? null,
      topic: reading?.topic ?? '',
      factIds: reading?.factIds ?? [],
      picked: picked.map((k) => ({ id: k.id, ar: k.ar, en: k.en, cta: k.cta ?? null })),
      draftPicked: !!draftId && picked.some((k) => k.id === draftId),
      draftHiddenByFlag,
      faqFallback,
      outcome,
      model: reading?.meta?.model ?? null,
      ms: reading?.meta?.ms ?? 0,
      costUsd: reading?.meta?.costUsd ?? 0,
    };
  }

  /** A draft that only lacks an id is still previewable (the id is just a label for this call). */
  private looseDraft(d: KnowledgeInput) {
    const probe = checkKnowledge({ ...d, id: typeof d.id === 'string' && d.id ? d.id : 'draft_preview' }, { requireId: false });
    return probe.value;
  }

  /**
   * A starting point for the editor. The model never supplies a fact: it
   * proposes an id and topic titles, and translates whatever answer the admin
   * already wrote into the other language. With no answer text it returns
   * topics only. The admin reviews every word before it is saved.
   */
  async draft(input: { question?: string; answerAr?: string; answerEn?: string }): Promise<DraftResult> {
    const question = plainLine(input.question, 300);
    const answerAr = plainLine(input.answerAr, 700);
    const answerEn = plainLine(input.answerEn, 700);
    if (!question && !answerAr && !answerEn) throw new BadRequestException('give a question or an answer to work from');

    let raw: string;
    let model: string | null = null;
    try {
      const res = await this.provider.getStructuredIntent({
        profile: 'public',
        reasoning: 'minimal',
        skipBudget: true,
        systemPrompt:
          'You help an admin of an Egyptian sports-venue booking app (Matchena) write one entry of a help knowledge base, in Egyptian Arabic and in English. ' +
          'HARD RULES: never invent a fact, price, time window, policy or feature. Use only the text the admin gave you. ' +
          'If an answer was given in one language, translate it faithfully into the other (Egyptian colloquial Arabic; plain English) without adding or removing claims. ' +
          'If no answer text was given, leave "ar" and "en" as empty strings. ' +
          '"id": a short snake_case slug (lower-case letters, digits, underscore; max 40) describing the topic. ' +
          '"topicAr"/"topicEn": ONE short line (max 12 words) a classifier reads to decide whether a player question is about this entry — write it like a player\'s question or a topic name. ' +
          'No links, no markdown, no emojis. Return JSON only.',
        userPrompt: JSON.stringify({ playerQuestion: question || null, answerAr: answerAr || null, answerEn: answerEn || null }),
        responseSchema: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' },
            topicAr: { type: 'STRING' },
            topicEn: { type: 'STRING' },
            ar: { type: 'STRING' },
            en: { type: 'STRING' },
          },
          required: ['id', 'topicAr', 'topicEn', 'ar', 'en'],
        },
      });
      raw = res.raw;
      model = res.model;
    } catch (err) {
      if (err instanceof AiUnavailableError) throw new BadRequestException({ message: 'AI_UNAVAILABLE', code: 'AI_UNAVAILABLE' });
      throw err;
    }
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.logger.warn('[ai-admin] draft was not JSON');
    }
    const slug = (v: unknown) =>
      String(v ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/^[0-9_]+/, '')
        .slice(0, 40);
    const hasAnswer = !!(answerAr || answerEn);
    // Whatever language the admin wrote is kept exactly; only the missing one comes from the model.
    return {
      id: slug(p['id']) || 'new_topic',
      topicAr: plainLine(p['topicAr'], 120),
      topicEn: plainLine(p['topicEn'], 120),
      ar: answerAr || (hasAnswer ? plainLine(p['ar'], 600) : ''),
      en: answerEn || (hasAnswer ? plainLine(p['en'], 600) : ''),
      model,
      note: hasAnswer ? 'translated' : 'topics_only',
    };
  }
}
