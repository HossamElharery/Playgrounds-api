/** Clamp untrusted pagination query values. */
export function clampLimit(
  raw: unknown,
  fallback = 30,
  max = 100,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), max);
}
