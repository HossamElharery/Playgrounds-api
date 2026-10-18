import type { ConfigService } from '@nestjs/config';

export function staffCallsEnabled(config: Pick<ConfigService, 'get'>): boolean {
  return (config.get<string>('STAFF_CALLS_ENABLED') ?? '').trim() === 'true';
}
