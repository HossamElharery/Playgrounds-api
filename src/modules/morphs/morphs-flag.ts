import type { ConfigService } from '@nestjs/config';

/**
 * `LOBBY_MORPHS_ENABLED=true` turns the feature on. Anything else (unset
 * included) keeps the app exactly as it was before Lobby Morphs.
 */
export function lobbyMorphsEnabled(
  config: Pick<ConfigService, 'get'>,
): boolean {
  return (config.get<string>('LOBBY_MORPHS_ENABLED') ?? '').trim() === 'true';
}
