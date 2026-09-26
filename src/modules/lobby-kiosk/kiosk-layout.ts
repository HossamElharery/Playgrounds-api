import type { BallAabb } from '../lobby-world/ball-sim';

/**
 * Sideline ribbon, same spot as the old booth, hanging above the pitch.
 * Mirrored by the client. There is no floor solid: the ball plays through.
 */
export const KIOSK_X = 7.4;
export const KIOSK_Z = 0;

/** Kept so older imports compile. The banner does not collide. */
export const KIOSK_SOLIDS: readonly BallAabb[] = [];
