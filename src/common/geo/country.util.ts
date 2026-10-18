export function normalizeCountryCode(
  code?: string | null,
): string | undefined {
  if (!code) return undefined;
  const normalized = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}
