/** Arabic-Indic (٠١٢…) and Persian (۰۱۲…) digits and separators → plain ASCII. */
export function asciiDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/[٬،]/g, ',');
}

/**
 * One spelling per number, so "01012345678", "+20 101 234 5678" and "٠١٠١٢٣٤٥٦٧٨" are the same
 * customer. Egyptian mobiles become `+20…`; other numbers keep their country code; anything that
 * cannot be a phone number returns null rather than being stored as noise.
 */
export function normalizeGuestPhone(raw: unknown): string | null {
  if (raw == null) return null;
  const text = asciiDigits(String(raw)).trim();
  if (!text || text.startsWith('pending-')) return null;
  const international = text.startsWith('+') || text.startsWith('00');
  let digits = text.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (international) return `+${digits}`;
  // Local Egyptian mobile: 01x xxxx xxxx
  if (/^01[0125]\d{8}$/.test(digits)) return `+20${digits.slice(1)}`;
  // Egyptian number typed with the country code but no plus: 201x xxxx xxxx
  if (/^201[0125]\d{8}$/.test(digits)) return `+${digits}`;
  return digits;
}

/** What to search for when the owner types part of a number: leading zeros and symbols never match the stored `+20…`. */
export function phoneSearchNeedle(query: string): string | null {
  const digits = asciiDigits(query).replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.replace(/^0+/, '') || null;
}

/** The phone to store for a booking: the canonical form, or what was typed if it is not a recognisable number (never silently dropped). */
export function guestPhoneForStorage(raw: unknown): string | null {
  const canonical = normalizeGuestPhone(raw);
  if (canonical) return canonical;
  const typed = raw == null ? '' : String(raw).trim();
  return typed && !typed.startsWith('pending-') ? typed.slice(0, 32) : null;
}
