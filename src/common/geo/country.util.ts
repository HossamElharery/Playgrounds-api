/** ISO 3166-1 alpha-2. Empty / junk input returns undefined. */
export function normalizeCountryCode(
  code?: string | null,
): string | undefined {
  if (!code) return undefined;
  const normalized = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}
