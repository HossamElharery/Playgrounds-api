import type { CaptainFilters, CaptainReading } from './captain.types';

const AR_DIACRITICS = /[ً-ْـ]/g;

/** Arabic spellings vary more than players do: compare on a flattened form. */
export function normalize(text: string): string {
  return text
    .replace(AR_DIACRITICS, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(
  (
    'في من على عن الي ال هل ايه اي ازاي كيف هو هي انا انت عايز عاوز عايزه ' +
    'the a an of to is are how do does i my can what where when for and or in on'
  ).split(' '),
);

export function tokens(text: string): string[] {
  return normalize(text)
    .split(' ')
    .map((t) => (t.startsWith('ال') && t.length > 4 ? t.slice(2) : t))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export interface FaqRow {
  id: string;
  questionAr: string;
  questionEn: string;
  answerAr: string;
  answerEn: string;
  ctaPath: string | null;
  ctaLabelAr: string | null;
  ctaLabelEn: string | null;
}

/** Equal, or one a prefix of the other ("حجز" / "حجزي"): Arabic hangs its pronouns on the word. */
function hasToken(set: Set<string>, t: string): boolean {
  if (set.has(t)) return true;
  if (t.length < 3) return false;
  for (const o of set) if (o.length >= 3 && (o.startsWith(t) || t.startsWith(o))) return true;
  return false;
}

/** Best real FAQ for a question, or null when nothing really matches. */
export function bestFaq(query: string, rows: FaqRow[]): FaqRow | null {
  const q = new Set(tokens(query));
  if (!q.size) return null;
  let best: { row: FaqRow; score: number } | null = null;
  for (const row of rows) {
    const inQuestion = new Set(tokens(`${row.questionAr} ${row.questionEn}`));
    const inAnswer = new Set(tokens(`${row.answerAr} ${row.answerEn}`));
    let score = 0;
    for (const t of q) {
      if (hasToken(inQuestion, t)) score += 3;
      else if (hasToken(inAnswer, t)) score += 1;
    }
    if (!best || score > best.score) best = { row, score };
  }
  // One stray shared word is not an answer.
  return best && best.score >= 4 ? best.row : null;
}

/** A model-written line is shown verbatim, so it is stripped of anything that is not plain words. */
export function plainLine(value: unknown, max = 240): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[<>`*_#\[\]{}|\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Only an in-app path, never a link out. */
export function safeAppPath(value: string | null | undefined): string | null {
  if (!value) return null;
  const path = value.replace(/^\/+/, '').split(/[?#]/)[0];
  return /^[a-z0-9][a-z0-9/_-]{0,80}$/i.test(path) ? path : null;
}

export const EMPTY_FILTERS: CaptainFilters = {
  sport: null,
  district: null,
  nearMe: false,
  cheap: false,
  priceMax: null,
  minRating: null,
  instantOnly: false,
  sort: null,
  timeHint: null,
};

export interface CatalogNames {
  sports: { slug: string; nameAr: string; nameEn: string }[];
  districts: { slug: string; nameAr: string; nameEn: string }[];
}

/**
 * What a plain keyword pass can still do when no model is reachable: spot a
 * sport or area by name, and the words for "close" and "cheap". Enough to keep
 * the search useful, never enough to pretend to understand.
 */
export function heuristicReading(text: string, catalog: CatalogNames): CaptainReading {
  const n = normalize(text);
  const has = (word: string) => !!word && n.includes(normalize(word));
  const sport = catalog.sports.find((s) => has(s.nameAr) || has(s.nameEn) || has(s.slug))?.slug;
  const district = catalog.districts.find((d) => has(d.nameAr) || has(d.nameEn))?.slug;
  const nearMe = /قريب|جنبي|حواليا|near/.test(n);
  const cheap = /رخيص|ارخص|اقتصاد|cheap|budget/.test(n);
  const found = !!(sport || district);
  return {
    ...EMPTY_FILTERS,
    sport: sport ?? null,
    district: district ?? null,
    nearMe,
    cheap,
    timeHint: /الليله|tonight/.test(n) ? 'tonight' : /دلوقتي|now/.test(n) ? 'now' : null,
    intent: found || nearMe || cheap ? 'find_venues' : 'unknown',
    followUp: false,
    topic: '',
    factIds: [],
    reply: '',
    question: '',
    confidence: found ? 0.6 : 0.3,
  };
}
