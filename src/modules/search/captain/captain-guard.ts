/**
 * The cheap questions asked before any model is paid for: is this even a
 * message? Everything here is plain string work, so a script that fires
 * nonsense at the endpoint costs us nothing.
 */
export type ScreenVerdict = { ok: true } | { ok: false; reason: 'empty' | 'noise' | 'spam' };

const LETTERS = /[\p{L}]/gu;
const URL = /https?:\/\/|www\./gi;

export function screenMessage(text: string, recent: string[] = []): ScreenVerdict {
  const t = text.trim();
  if (t.length < 2) return { ok: false, reason: 'empty' };
  const letters = t.match(LETTERS)?.length ?? 0;
  // Digits, emoji and punctuation only.
  if (letters === 0) return { ok: false, reason: 'noise' };
  // "aaaaaaaaaa", "ههههههههههه…": one character making up most of a longer message.
  if (t.length >= 8) {
    const counts = new Map<string, number>();
    for (const ch of t.replace(/\s/g, '')) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const top = Math.max(...counts.values());
    if (top / t.replace(/\s/g, '').length > 0.7) return { ok: false, reason: 'noise' };
  }
  if ((t.match(URL) ?? []).length >= 2) return { ok: false, reason: 'spam' };
  // The same message a third time in a row.
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const last = recent.slice(-2).map(norm);
  if (last.length === 2 && last.every((m) => m === norm(t))) return { ok: false, reason: 'spam' };
  return { ok: true };
}
