import type { ConfigService } from '@nestjs/config';

function on(config: Pick<ConfigService, 'get'>, key: string): boolean {
  return (config.get<string>(key) ?? '').trim() === 'true';
}

export function lobbyMovementEnabled(
  config: Pick<ConfigService, 'get'>,
): boolean {
  return on(config, 'LOBBY_MOVEMENT_ENABLED');
}

export function lobbyBallEnabled(config: Pick<ConfigService, 'get'>): boolean {
  return lobbyMovementEnabled(config) && on(config, 'LOBBY_BALL_ENABLED');
}
