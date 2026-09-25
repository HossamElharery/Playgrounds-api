import type { ConfigService } from '@nestjs/config';

function on(config: Pick<ConfigService, 'get'>, key: string): boolean {
  return (config.get<string>(key) ?? '').trim() === 'true';
}

/**
 * `LOBBY_MOVEMENT_ENABLED=true` turns lobby movement on. Anything else (unset
 * included) keeps the lobby exactly as before: every `lobby.*` message is ignored.
 */
export function lobbyMovementEnabled(
  config: Pick<ConfigService, 'get'>,
): boolean {
  return on(config, 'LOBBY_MOVEMENT_ENABLED');
}

/** The lobby ball needs movement: `LOBBY_BALL_ENABLED=true` alone does nothing. */
export function lobbyBallEnabled(config: Pick<ConfigService, 'get'>): boolean {
  return lobbyMovementEnabled(config) && on(config, 'LOBBY_BALL_ENABLED');
}
