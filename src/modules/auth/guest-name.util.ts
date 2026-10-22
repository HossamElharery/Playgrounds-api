/** Cleans a guest's nickname: no control or bidi-override characters, collapsed spaces, 24 characters, a default «ضيف 1234». */
export function guestDisplayName(raw: string | undefined, lang: 'ar' | 'en' | undefined, random: () => number = Math.random): string {
  const cleaned = (raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  const suffix = String(1000 + Math.floor(random() * 9000));
  return cleaned || (lang === 'en' ? `Guest ${suffix}` : `ضيف ${suffix}`);
}
