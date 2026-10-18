export function normalizeOptionalPhone(
  value: unknown,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.startsWith('pending-')) return null;
  return trimmed;
}

export function maskPlayerPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '•••';
  const tail = digits.slice(-2);
  const head = phone.startsWith('+') ? phone.slice(0, 4) : phone.slice(0, 3);
  return `${head}••• ••${tail}`;
}
