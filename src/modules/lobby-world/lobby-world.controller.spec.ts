import { LobbyWorldController } from './lobby-world.controller';
import { lobbyBallEnabled, lobbyMovementEnabled } from './lobby-world-flags';

describe('GET /lobby/features', () => {
  const controller = (env: Record<string, string | undefined>) =>
    new LobbyWorldController({ get: (k: string) => env[k] } as any);

  it.each([
    [{}, { movement: false, ball: false }],
    [{ LOBBY_MOVEMENT_ENABLED: 'true' }, { movement: true, ball: false }],
    [{ LOBBY_BALL_ENABLED: 'true' }, { movement: false, ball: false }],
    [
      { LOBBY_MOVEMENT_ENABLED: 'true', LOBBY_BALL_ENABLED: 'true' },
      { movement: true, ball: true },
    ],
    [
      { LOBBY_MOVEMENT_ENABLED: ' true ', LOBBY_BALL_ENABLED: 'true' },
      { movement: true, ball: true },
    ],
    [
      { LOBBY_MOVEMENT_ENABLED: 'TRUE', LOBBY_BALL_ENABLED: '1' },
      { movement: false, ball: false },
    ],
    [
      { LOBBY_MOVEMENT_ENABLED: '', LOBBY_BALL_ENABLED: '' },
      { movement: false, ball: false },
    ],
  ])('%j → %j', (env, expected) => {
    expect(controller(env).features()).toEqual(expected);
  });

  it('ball is only ever on together with movement', () => {
    const cfg = (m?: string, b?: string) => ({
      get: (k: string) =>
        k === 'LOBBY_MOVEMENT_ENABLED'
          ? m
          : k === 'LOBBY_BALL_ENABLED'
            ? b
            : undefined,
    });
    for (const m of [undefined, 'true', 'false'])
      for (const b of [undefined, 'true', 'false']) {
        if (lobbyBallEnabled(cfg(m, b)))
          expect(lobbyMovementEnabled(cfg(m, b))).toBe(true);
      }
  });
});
