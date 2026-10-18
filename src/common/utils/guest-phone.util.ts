export function asciiDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/[٬،]/g, ',');
}

interface PhoneRegion {
  dial: string;
  local: Array<{ pattern: RegExp; trunk: boolean }>;
}
const REGIONS: Record<string, PhoneRegion> = {
  EG: { dial: '20', local: [{ pattern: /^01[0125]\d{8}$/, trunk: true }] },
  AE: { dial: '971', local: [{ pattern: /^05[024568]\d{7}$/, trunk: true }] },
  SA: { dial: '966', local: [{ pattern: /^05\d{8}$/, trunk: true }] },
  KW: { dial: '965', local: [{ pattern: /^[569]\d{7}$/, trunk: false }] },
  QA: { dial: '974', local: [{ pattern: /^[3567]\d{7}$/, trunk: false }] },
  JO: { dial: '962', local: [{ pattern: /^07[789]\d{7}$/, trunk: true }] },
};

export function normalizeGuestPhone(raw: unknown, countryCode = 'EG'): string | null {
  if (raw == null) return null;
  const text = asciiDigits(String(raw)).trim();
  if (!text || text.startsWith('pending-')) return null;
  const international = text.startsWith('+') || text.startsWith('00');
  let digits = text.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (international) return `+${digits}`;
  const region = REGIONS[countryCode.toUpperCase()] ?? REGIONS['EG'];
  for (const rule of region.local) {
    if (rule.pattern.test(digits)) return `+${region.dial}${rule.trunk ? digits.slice(1) : digits}`;
    // The same number typed with its country code but no plus (2010…, 97150…).
    if (digits.startsWith(region.dial)) {
      const rest = digits.slice(region.dial.length);
      if (rule.pattern.test(rule.trunk ? `0${rest}` : rest)) return `+${digits}`;
    }
  }
  return digits;
}

export function phoneSearchNeedle(query: string): string | null {
  const digits = asciiDigits(query).replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.replace(/^0+/, '') || null;
}

export function guestPhoneForStorage(raw: unknown, countryCode = 'EG'): string | null {
  const canonical = normalizeGuestPhone(raw, countryCode);
  if (canonical) return canonical;
  const typed = raw == null ? '' : String(raw).trim();
  return typed && !typed.startsWith('pending-') ? typed.slice(0, 32) : null;
}
