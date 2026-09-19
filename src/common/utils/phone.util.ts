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
