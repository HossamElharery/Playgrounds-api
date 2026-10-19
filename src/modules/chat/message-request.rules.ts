/**
 * Content rules for the one message a stranger may send before the recipient
 * replies. Pure functions so the exact same logic can be unit-tested and
 * mirrored by the client for instant feedback (the server stays authoritative).
 */

export const REQUEST_MESSAGE_MAX_LENGTH = 300;

export type RequestContentViolation =
  | 'MESSAGE_REQUEST_TEXT_ONLY'
  | 'MESSAGE_REQUEST_TOO_LONG'
  | 'MESSAGE_REQUEST_NO_LINKS'
  | 'MESSAGE_REQUEST_NO_CONTACT_INFO';

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_INDIC = '۰۱۲۳۴۵۶۷۸۹';
// Zero-width and bidi control characters are a common way to split a link or
// number so naive filters miss it.
const INVISIBLE = new RegExp(
  '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u00AD]',
  'g',
);

export function normalizeForScan(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_INDIC.indexOf(d)));
}

const TLDS =
  'com|net|org|io|me|app|ly|co|eg|gl|link|xyz|info|biz|ru|tk|cc|tv|ws|site|online|shop|store|club|top|vip|live|chat|page|dev|ai|sa|ae|kw|qa';
const LINK_PATTERNS: RegExp[] = [
  /\b(?:https?|ftp):\/\//i,
  /\bwww\s?\./i,
  new RegExp(
    `[\\p{L}\\d-]{2,}\\s?(?:\\.|\\(dot\\)|\\[dot\\]|\\sdot\\s)\\s?(?:${TLDS})(?![\\p{L}\\d])`,
    'iu',
  ),
  /\b(?:wa\.me|t\.me|bit\.ly|tinyurl|linktr\.ee|instagram\.com|facebook\.com|fb\.me|m\.me|discord\.gg)\b/i,
];

export function containsLink(text: string): boolean {
  const scan = normalizeForScan(text);
  return LINK_PATTERNS.some((p) => p.test(scan));
}

/** 8+ digits, even when broken up by spaces, dots, dashes, brackets or a +. */
export function containsPhoneNumber(text: string): boolean {
  // Calendar dates are legitimate in "let's play on 2026-10-19" style messages.
  const scan = normalizeForScan(text)
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, ' ');
  const runs = scan.match(/\+?\d(?:[\s().\-_/\\|]*\d){7,}/g) ?? [];
  return runs.some((run) => run.replace(/\D/g, '').length >= 8);
}

export function validateRequestMessage(input: {
  type: string;
  text?: string | null;
}): RequestContentViolation | null {
  if (input.type !== 'text') return 'MESSAGE_REQUEST_TEXT_ONLY';
  const text = (input.text ?? '').trim();
  if (text.length > REQUEST_MESSAGE_MAX_LENGTH)
    return 'MESSAGE_REQUEST_TOO_LONG';
  if (containsLink(text)) return 'MESSAGE_REQUEST_NO_LINKS';
  if (containsPhoneNumber(text)) return 'MESSAGE_REQUEST_NO_CONTACT_INFO';
  return null;
}

/** Canonical form used to detect the same text blasted to many strangers. */
export function fingerprintMessage(text: string): string {
  return normalizeForScan(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
