import type { ConfigService } from '@nestjs/config';

/**
 * `STAFF_CALLS_ENABLED=true` turns owner/staff calling on. Anything else (unset included) keeps the
 * API exactly as it was: the directory reports `enabled: false` and every other call route answers 404.
 */
export function staffCallsEnabled(config: Pick<ConfigService, 'get'>): boolean {
  return (config.get<string>('STAFF_CALLS_ENABLED') ?? '').trim() === 'true';
}
