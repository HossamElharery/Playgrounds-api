import type { BallAabb } from '../lobby-world/ball-sim';

/**
 * Round holo table on the lobby floor, radius 1.15, facing the centre.
 * Mirrored by the client builder. The ball box is the square around that circle.
 */
export const KIOSK_X = 7.4;
export const KIOSK_Z = 0;
export const KIOSK_RADIUS = 1.15;
export const KIOSK_HEIGHT = 0.95;

/** Solid box the authoritative ball bounces off while the kiosk flag is on. */
export const KIOSK_BALL_BOX: BallAabb = {
  minX: KIOSK_X - KIOSK_RADIUS,
  maxX: KIOSK_X + KIOSK_RADIUS,
  minZ: KIOSK_Z - KIOSK_RADIUS,
  maxZ: KIOSK_Z + KIOSK_RADIUS,
  maxY: KIOSK_HEIGHT,
};
