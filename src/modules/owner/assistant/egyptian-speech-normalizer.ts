const DIGIT_NAMES = ['صفر', 'واحد', 'اتنين', 'تلاتة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'تمانية', 'تسعة'];
const ONES = ['', 'واحد', 'اتنين', 'تلاتة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'تمانية', 'تسعة'];
const TEENS: Record<number, string> = {
  10: 'عشرة', 11: 'حداشر', 12: 'اتناشر', 13: 'تلتاشر', 14: 'أربعتاشر',
  15: 'خمستاشر', 16: 'ستاشر', 17: 'سبعتاشر', 18: 'تمنتاشر', 19: 'تسعتاشر',
};
const TENS = ['', '', 'عشرين', 'تلاتين', 'أربعين', 'خمسين', 'ستين', 'سبعين', 'تمانين', 'تسعين'];
const HUNDREDS = ['', 'مية', 'ميتين', 'تلتمية', 'ربعمية', 'خمسمية', 'ستمية', 'سبعمية', 'تمنمية', 'تسعمية'];
const MONTHS = ['', 'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function underThousand(value: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds) parts.push(HUNDREDS[hundreds]);
  if (rest) {
    if (rest < 10) parts.push(ONES[rest]);
    else if (rest < 20) parts.push(TEENS[rest]);
    else {
      const ones = rest % 10;
      if (ones) parts.push(`${ONES[ones]} و${TENS[Math.floor(rest / 10)]}`);
      else parts.push(TENS[Math.floor(rest / 10)]);
    }
  }
  return parts.join(' و');
}

export function egyptianInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 999_999_999) return String(value);
  if (value === 0) return DIGIT_NAMES[0];
  const millions = Math.floor(value / 1_000_000);
  const thousands = Math.floor((value % 1_000_000) / 1_000);
  const rest = value % 1_000;
  const parts: string[] = [];
  if (millions) {
    if (millions === 1) parts.push('مليون');
    else if (millions === 2) parts.push('مليونين');
    else parts.push(`${underThousand(millions)} مليون`);
  }
  if (thousands) {
    if (thousands === 1) parts.push('ألف');
    else if (thousands === 2) parts.push('ألفين');
    else parts.push(`${underThousand(thousands)} ألف`);
  }
  if (rest) parts.push(underThousand(rest));
  return parts.join(' و');
}

function digitsIndividually(value: string): string {
  return value.replace(/\D/g, '').split('').map((digit) => DIGIT_NAMES[Number(digit)]).join('، ');
}

function asciiDigits(text: string): string {
  const ar = '٠١٢٣٤٥٦٧٨٩';
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  return text.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arIndex = ar.indexOf(digit);
    return String(arIndex >= 0 ? arIndex : fa.indexOf(digit));
  });
}

function egyptianClock(hour24: number, minute: number): string {
  const hour12 = hour24 % 12 || 12;
  const period = hour24 >= 5 && hour24 < 12
    ? 'الصبح'
    : hour24 >= 12 && hour24 < 16
      ? 'الضهر'
      : hour24 >= 16 && hour24 < 19
        ? 'العصر'
        : 'بالليل';
  if (minute === 0) return `الساعة ${egyptianInteger(hour12)} ${period}`;
  if (minute === 15) return `الساعة ${egyptianInteger(hour12)} وربع ${period}`;
  if (minute === 30) return `الساعة ${egyptianInteger(hour12)} ونص ${period}`;
  if (minute === 45) return `الساعة ${egyptianInteger((hour12 % 12) + 1)} إلا ربع ${period}`;
  return `الساعة ${egyptianInteger(hour12)} و${egyptianInteger(minute)} دقيقة ${period}`;
}

/** Makes operational Arabic safe and predictable for Egyptian TTS voices. */
export function normalizeEgyptianSpeech(input: string): string {
  let text = asciiDigits(input)
    .replace(/[✅❌💰📅📍•▪◦]/gu, ' ')
    .replace(/[\r\n]+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();

  const protectedPhones: string[] = [];
  text = text.replace(/(?:\+?20[\s-]?)?0?1[0125](?:[\s-]?\d){8}\b/g, (phone) => {
    const token = `PHONEPLACEHOLDER${protectedPhones.length}X`;
    protectedPhones.push(digitsIndividually(phone));
    return token;
  });

  text = text.replace(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g, (_match, year: string, month: string, day: string) =>
    `${egyptianInteger(Number(day))} ${MONTHS[Number(month)]} ${egyptianInteger(Number(year))}`,
  );

  text = text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_match, hour: string, minute: string) => {
    return egyptianClock(Number(hour), Number(minute));
  });

  text = text.replace(/\b(\d{1,3}(?:,\d{3})+|\d+)\s*(?:ج\.م|جنيه(?:ات)?|EGP)(?=\s|[،,.!?؟]|$)/gi, (_match, amount: string) =>
    `${egyptianInteger(Number(amount.replace(/,/g, '')))} جنيه`,
  );
  text = text.replace(/\b(\d{1,3}(?:,\d{3})+|\d+)\s*(?:د\.إ|درهم|AED)(?=\s|[،,.!?؟]|$)/gi, (_match, amount: string) =>
    `${egyptianInteger(Number(amount.replace(/,/g, '')))} درهم`,
  );
  text = text.replace(/\b(\d{1,3}(?:,\d{3})+|\d+)\s*(?:ر\.س|ريال|SAR)(?=\s|[،,.!?؟]|$)/gi, (_match, amount: string) =>
    `${egyptianInteger(Number(amount.replace(/,/g, '')))} ريال`,
  );
  text = text.replace(/\b(\d{1,3}(?:,\d{3})+|\d+)\b/g, (_match, value: string) =>
    egyptianInteger(Number(value.replace(/,/g, ''))),
  );
  text = text.replace(/PHONEPLACEHOLDER(\d+)X/g, (_match, index: string) => protectedPhones[Number(index)] ?? '');

  return text
    .replace(/\s+([،,.!?؟])/g, '$1')
    .replace(/([.!؟])(?:\s*[.!؟])+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

export function escapeSpeechXml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]!);
}
