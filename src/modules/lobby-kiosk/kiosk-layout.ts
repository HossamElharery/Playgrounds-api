import type { BallAabb } from '../lobby-world/ball-sim';

/**
 * Kiosk on the lobby floor: angle 90° (to the right of the default camera,
 * which looks toward −z), radius 7.4, facing the centre. The booth is 1.6
 * wide × 0.9 deep × 1.1 high. Mirrored by the client builder.
 */
export const KIOSK_X = 7.4;
export const KIOSK_Z = 0;
/** Half-depth along world X, half-width along world Z, after facing the centre. */
export const KIOSK_HALF_DEPTH = 0.45;
export const KIOSK_HALF_WIDTH = 0.8;
export const KIOSK_HEIGHT = 1.1;

/** Solid box the authoritative ball bounces off while the kiosk flag is on. */
export const KIOSK_BALL_BOX: BallAabb = {
  minX: KIOSK_X - KIOSK_HALF_DEPTH,
  maxX: KIOSK_X + KIOSK_HALF_DEPTH,
  minZ: KIOSK_Z - KIOSK_HALF_WIDTH,
  maxZ: KIOSK_Z + KIOSK_HALF_WIDTH,
  maxY: KIOSK_HEIGHT,
};
