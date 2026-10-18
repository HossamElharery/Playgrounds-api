import type { ConfigService } from '@nestjs/config';

export function lobbyKioskEnabled(
  config: Pick<ConfigService, 'get'>,
): boolean {
  return (config.get<string>('LOBBY_KIOSK_ENABLED') ?? '').trim() === 'true';
}
