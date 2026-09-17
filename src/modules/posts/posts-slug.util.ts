const AR_MAP: Record<string, string> = {
  ا: 'a',
  أ: 'a',
  إ: 'i',
  آ: 'a',
  ب: 'b',
  ت: 't',
  ث: 'th',
  ج: 'g',
  ح: 'h',
  خ: 'kh',
  د: 'd',
  ذ: 'z',
  ر: 'r',
  ز: 'z',
  س: 's',
  ش: 'sh',
  ص: 's',
  ض: 'd',
  ط: 't',
  ظ: 'z',
  ع: 'a',
  غ: 'gh',
  ف: 'f',
  ق: 'q',
  ك: 'k',
  ل: 'l',
  م: 'm',
  ن: 'n',
  ه: 'h',
  و: 'w',
  ي: 'y',
  ى: 'a',
  ة: 'a',
  ء: '',
  ئ: 'y',
  ؤ: 'w',
  ' ': '-',
};

export function slugifyPost(text: string, fallback = 'post'): string {
  const words = text
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(' ');
  const transliterated = [...(words || fallback)]
    .map((ch) => AR_MAP[ch] ?? ch)
    .join('');
  const ascii = transliterated
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return ascii.slice(0, 72) || fallback;
}

export function permalinkSlug(slug: string, id: string): string {
  return `${slug}-${id}`;
}

export function parsePermalinkParam(value: string): { slug?: string; id: string } {
  const uuidAtEnd =
    /(?:^|-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      value,
    );
  if (uuidAtEnd) {
    return { id: uuidAtEnd[1], slug: value.slice(0, -uuidAtEnd[0].length).replace(/-$/, '') };
  }
  return { id: value };
}
