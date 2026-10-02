import { safeAppPath, tokens } from '../../search/captain/captain-text';
import type { KnowledgeEntry, KnowledgeFlag } from './default-knowledge';

/** Destinations the player app already knows by name; anything else must be a safe in-app path. */
export const NAMED_DESTINATIONS = ['players', 'chat', 'community', 'tonight', 'bookings', 'help', 'login', 'explore'] as const;
export const KNOWLEDGE_FLAGS: KnowledgeFlag[] = ['morphs', 'movement', 'ball', 'kiosk'];

export const MAX_ANSWER_CHARS = 600;
export const MAX_TOPIC_CHARS = 120;
export const MAX_CTA_LABEL_CHARS = 60;
const ID_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;

export interface KnowledgeInput {
  id?: unknown;
  topicAr?: unknown;
  topicEn?: unknown;
  ar?: unknown;
  en?: unknown;
  ctaTarget?: unknown;
  ctaLabelAr?: unknown;
  ctaLabelEn?: unknown;
  flag?: unknown;
  active?: unknown;
}

/** What gets stored. */
export interface KnowledgeValue {
  id: string;
  topicAr: string;
  topicEn: string;
  ar: string;
  en: string;
  ctaTarget: string | null;
  ctaLabelAr: string | null;
  ctaLabelEn: string | null;
  flag: KnowledgeFlag | null;
  active: boolean;
}

export type KnowledgeWarning =
  | { code: 'promise_word'; field: 'ar' | 'en'; word: string }
  | { code: 'topic_overlap'; with: string; score: number };

export interface KnowledgeCheck {
  errors: Record<string, string>;
  warnings: KnowledgeWarning[];
  value: KnowledgeValue | null;
}

/** Words that promise something the app may not always do. A warning, never a block: the admin knows the facts. */
const PROMISE_WORDS: Record<'ar' | 'en', string[]> = {
  ar: ['مضمون', 'نضمن', 'بنضمن', 'هنضمن', 'دايما', 'دائما', 'أبدا', 'ابدا', 'مجاني', 'مجانا', 'بالمجان', 'بدون رسوم', '100%'],
  en: ['guarantee', 'guaranteed', 'always', 'never', 'free of charge', 'for free', 'promise', 'definitely', '100%'],
};

function normalizedForPromise(text: string): string {
  return text
    .replace(/[ً-ْـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .toLowerCase();
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/** Jaccard overlap of two topics' words, so two entries a model could not tell apart are flagged. */
export function topicOverlap(a: string, b: string): number {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/** An external link, markup or a script scheme has no place in text shown verbatim in the app. */
function hasLinkOrMarkup(text: string): boolean {
  return /(?:https?:\/\/|www\.|javascript:|data:)/i.test(text) || /<\/?[a-z][^>]*>/i.test(text);
}

export function isSafeCtaTarget(target: string): boolean {
  if ((NAMED_DESTINATIONS as readonly string[]).includes(target)) return true;
  if (/[:@]|\/\//.test(target) || /^https?/i.test(target)) return false;
  return safeAppPath(target) === target.replace(/^\/+/, '');
}

/**
 * Checks what an admin typed. `others` are the other entries, to warn when
 * two topics would confuse the model. Errors block saving; warnings do not.
 */
export function checkKnowledge(
  input: KnowledgeInput,
  opts: { requireId: boolean; others?: Pick<KnowledgeEntry, 'id' | 'topicAr' | 'topicEn'>[] },
): KnowledgeCheck {
  const errors: Record<string, string> = {};
  const warnings: KnowledgeWarning[] = [];

  const id = str(input.id);
  if (opts.requireId && !ID_PATTERN.test(id)) errors['id'] = 'invalid_id';
  if (opts.requireId && opts.others?.some((o) => o.id === id)) errors['id'] = 'duplicate_id';

  const topicAr = str(input.topicAr);
  const topicEn = str(input.topicEn);
  for (const [field, v] of [['topicAr', topicAr], ['topicEn', topicEn]] as const) {
    if (v.length < 3) errors[field] = 'required';
    else if (v.length > MAX_TOPIC_CHARS) errors[field] = 'too_long';
    else if (hasLinkOrMarkup(v)) errors[field] = 'no_links';
  }

  const ar = str(input.ar);
  const en = str(input.en);
  for (const [field, v] of [['ar', ar], ['en', en]] as const) {
    if (!v) errors[field] = 'required';
    else if (v.length > MAX_ANSWER_CHARS) errors[field] = 'too_long';
    else if (hasLinkOrMarkup(v)) errors[field] = 'no_links';
  }

  let ctaTarget = str(input.ctaTarget).replace(/^\/+/, '');
  let ctaLabelAr = str(input.ctaLabelAr);
  let ctaLabelEn = str(input.ctaLabelEn);
  if (ctaTarget) {
    if (!isSafeCtaTarget(ctaTarget)) errors['ctaTarget'] = 'unsafe_target';
    if (!ctaLabelAr) errors['ctaLabelAr'] = 'required';
    if (!ctaLabelEn) errors['ctaLabelEn'] = 'required';
    if (ctaLabelAr.length > MAX_CTA_LABEL_CHARS) errors['ctaLabelAr'] = 'too_long';
    if (ctaLabelEn.length > MAX_CTA_LABEL_CHARS) errors['ctaLabelEn'] = 'too_long';
  } else {
    ctaTarget = '';
    ctaLabelAr = '';
    ctaLabelEn = '';
  }

  let flag: KnowledgeFlag | null = null;
  if (input.flag !== undefined && input.flag !== null && input.flag !== '') {
    if (KNOWLEDGE_FLAGS.includes(input.flag as KnowledgeFlag)) flag = input.flag as KnowledgeFlag;
    else errors['flag'] = 'invalid_flag';
  }

  if (input.active !== undefined && typeof input.active !== 'boolean') errors['active'] = 'invalid_value';

  if (!Object.keys(errors).length) {
    for (const [field, text] of [['ar', ar], ['en', en]] as const) {
      const norm = normalizedForPromise(text);
      for (const word of PROMISE_WORDS[field]) {
        if (norm.includes(normalizedForPromise(word))) {
          warnings.push({ code: 'promise_word', field, word });
          break;
        }
      }
    }
    for (const other of opts.others ?? []) {
      if (other.id === id) continue;
      const score = Math.max(
        topicOverlap(topicAr, other.topicAr),
        topicOverlap(topicEn, other.topicEn),
        topicOverlap(`${topicAr} ${topicEn}`, `${other.topicAr} ${other.topicEn}`),
      );
      if (score >= 0.5) warnings.push({ code: 'topic_overlap', with: other.id, score: Number(score.toFixed(2)) });
    }
  }

  if (Object.keys(errors).length) return { errors, warnings, value: null };
  return {
    errors,
    warnings,
    value: {
      id,
      topicAr,
      topicEn,
      ar,
      en,
      ctaTarget: ctaTarget || null,
      ctaLabelAr: ctaLabelAr || null,
      ctaLabelEn: ctaLabelEn || null,
      flag,
      active: input.active === undefined ? true : (input.active as boolean),
    },
  };
}
