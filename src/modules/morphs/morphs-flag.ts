import type { ConfigService } from '@nestjs/config';

export function lobbyMorphsEnabled(
  config: Pick<ConfigService, 'get'>,
): boolean {
  return (config.get<string>('LOBBY_MORPHS_ENABLED') ?? '').trim() === 'true';
}
