/**
 * Deterministic court resolution.
 *
 * The model is asked for court ids, but a weaker fallback model (or a spoken
 * "بلايستيشن 5 برو 1" against a court called "PS5 Room 1") regularly returns
 * none. Rather than asking the owner a question they already answered, the
 * sentence is matched against the venue's own courts here — names, console
 * type, room tier — and only a single unambiguous winner is accepted.
 */

export interface CourtCandidate {
  id: string;
  name: string;
  /** Extra searchable text: console type, room tier, sport, format... */
  hints?: string;
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Words that say nothing about *which* court, so they never decide a match. */
const GENERIC = new Set([
  'room', 'court', 'the', 'a', 'an', 'in', 'at', 'for', 'on', 'of', 'and',
  'في', 'ال', 'علي', 'على', 'من', 'ل', 'و', 'عايز', 'عايزك', 'احجز', 'حجز', 'هيحجز', 'تحجز',
  'ملعب', 'كورت', 'غرفه', 'طاوله', 'جهاز',
]);

export function normalizeForMatch(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ً-ْـ]/g, '')
    .toLowerCase()
    // "بي اس 5" / "بلايستيشن 5" / "playstation 5" → ps5
    .replace(/بي\s?اس\s?(\d)/g, 'ps$1')
    .replace(/(?:بلاي?\s?ستيشن|playstation|بلستيشن)\s?(\d)?/g, (_m, n) => `ps${n ?? ''}`)
    .replace(/\bps\s+(\d)/g, 'ps$1')
    .replace(/(^|\s)برو(?=\s|$)/g, '$1pro')
    .replace(/غرفه|روم/g, 'room')
    .replace(/في\s?اي\s?بي|فيب/g, 'vip')
    .replace(/شاشه\s?كبيره/g, 'big screen')
    .replace(/[^\p{L}\p{N}\s:.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text: string): string[] {
  return text.split(' ').filter(Boolean);
}

/**
 * Numbers in a booking sentence are mostly clock times and money. A number
 * only counts as a court number when it sits right behind a court-ish word,
 * or when the whole message is a short answer to "which court?".
 */
function courtNumbers(text: string): Set<string> {
  const found = new Set<string>();
  const toks = tokens(text.replace(/\d{1,2}:\d{2}/g, ' '));
  const short = toks.length <= 4;
  toks.forEach((tok, i) => {
    if (!/^\d{1,2}$/.test(tok)) return;
    const prev = toks[i - 1] ?? '';
    if (short || /^(ps\d?|pro|room|court|ملعب|كورت|غرفه|طاوله|جهاز|ستيشن|vip|table)$/.test(prev)) {
      found.add(tok);
    }
  });
  return found;
}

export function resolveCourtFromText(
  text: string,
  courts: CourtCandidate[],
): string | null {
  const wanted = normalizeForMatch(text);
  if (!wanted || !courts.length) return null;
  const wantedTokens = new Set(tokens(wanted.replace(/\d{1,2}:\d{2}/g, ' ')));
  const nums = courtNumbers(wanted);

  let best: { id: string; score: number } | null = null;
  let tie = false;
  for (const court of courts) {
    const haystack = normalizeForMatch(`${court.name} ${court.hints ?? ''}`);
    const nameTokens = new Set(tokens(normalizeForMatch(court.name)));
    const hayTokens = new Set(tokens(haystack));
    let score = 0;

    // The full court name appearing verbatim is the strongest signal there is.
    const fullName = normalizeForMatch(court.name);
    if (fullName.length >= 3 && wanted.includes(fullName)) score += 6;

    for (const tok of wantedTokens) {
      if (GENERIC.has(tok)) continue;
      if (/^\d+$/.test(tok)) {
        if (nums.has(tok) && nameTokens.has(tok)) score += 3;
        continue;
      }
      if (nameTokens.has(tok)) score += 2;
      else if (hayTokens.has(tok)) score += 1;
    }
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { id: court.id, score };
      tie = false;
    } else if (score === best.score) {
      tie = true;
    }
  }
  // Two courts scoring the same means the sentence did not say which.
  return best && !tie ? best.id : null;
}

/**
 * The venue's units as one readable list. Two units can share a name across sports («Table 1» for
 * billiards and for ping-pong): then each is followed by its sport so the owner can answer.
 */
export function listUnits(units: { name: string; sportAr?: string | null }[], separator = '، '): string {
  const seen = new Map<string, number>();
  for (const u of units) seen.set(u.name, (seen.get(u.name) ?? 0) + 1);
  return units
    .map((u) => ((seen.get(u.name) ?? 0) > 1 && u.sportAr ? `${u.name} (${u.sportAr})` : u.name))
    .join(separator);
}
