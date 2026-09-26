import type { ConfigService } from '@nestjs/config';

/**
 * `LOBBY_KIOSK_ENABLED=true` turns the booking kiosk on. Anything else (unset
 * included) keeps the lobby exactly as before: every `lobby.kiosk.*` message
 * is ignored and `GET /lobby/features` reports `kiosk: false`.
 *
 * The flag is independent of `LOBBY_MOVEMENT_ENABLED`. Walking can be off and
 * the dock "احجز ملعب" button can still open the kiosk panel.
 */
export function lobbyKioskEnabled(
  config: Pick<ConfigService, 'get'>,
): boolean {
  return (config.get<string>('LOBBY_KIOSK_ENABLED') ?? '').trim() === 'true';
}
