import { BadRequestException } from '@nestjs/common';
export type PlayMode = 'standard' | 'multi';
export function gamingConfigObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Never infer a paid mode from seats. An absent legacy mode means standard. */
export function selectGamingTariff(config: unknown, standardMinor: number, mode: PlayMode = 'standard'): number {
  if (mode === 'standard') return standardMinor;
  const c = gamingConfigObject(config);
  if (!['ps4', 'ps5', 'xbox-series'].includes(String(c.consoleType)) || !Number.isSafeInteger(c.multiHourlyRateMinor) || Number(c.multiHourlyRateMinor) <= 0 || Number(c.multiHourlyRateMinor) > 10000000) {
    throw new BadRequestException({ code: 'MULTI_PRICING_REQUIRED' });
  }
  return Number(c.multiHourlyRateMinor);
}
