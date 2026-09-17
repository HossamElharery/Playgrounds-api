/** Lightweight denylist used only to exclude posts from the coins engine.
 *  This is not a full moderation pipeline — reports still go to admins. */
const BLOCKED = [
  'spam',
  'scam',
  'porn',
  'xxx',
  'nude',
  'nudes',
  'سكس',
  'قمار',
  'نصب',
  'احتيال',
];

export function containsBlockedLanguage(text: string): boolean {
  const hay = text.toLowerCase();
  return BLOCKED.some((word) => hay.includes(word));
}

export function extractHashtags(text: string): string[] {
  const matches = text.match(/#([\p{L}\p{N}_]{2,40})/gu) ?? [];
  const tags = matches.map((m) => m.slice(1).toLowerCase());
  return [...new Set(tags)];
}

export function extractMentionTokens(text: string): string[] {
  const matches = text.match(/@([A-Za-z0-9._]{2,30})/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))];
}
