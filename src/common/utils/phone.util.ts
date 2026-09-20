/** Blank / placeholder phones become `null` so the unique column stays nullable. */
export function normalizeOptionalPhone(
  value: unknown,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.startsWith('pending-')) return null;
  return trimmed;
}

/** Mask a platform player's phone for owner views: `+20 10••• ••34`. */
export function maskPlayerPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '•••';
  const tail = digits.slice(-2);
  const head = phone.startsWith('+') ? phone.slice(0, 4) : phone.slice(0, 3);
  return `${head}••• ••${tail}`;
}
