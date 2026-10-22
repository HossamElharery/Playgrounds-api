/**
 * Hits and sight: pure geometry for tags, forbidden zones and who can see whom. The ball itself lives in
 * `camo-ball-sim.ts`; this file never produces a hit marker, it only answers questions the server asks.
 */
import { CARD, HIT_VOLUME, MOVE } from './camo-constants';
import { insideAabb2d, lineBlocked, type CamoRoomData } from './camo-room';

export interface Point2 {
  x: number;
  z: number;
}

/** A seeker's lunge hits a hider inside a 60 degree cone within 1.6 m. Pose never changes the volume. */
export function tagHits(seeker: Point2 & { yaw: number }, hider: Point2): boolean {
  const dx = hider.x - seeker.x;
  const dz = hider.z - seeker.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > CARD.tagRange + HIT_VOLUME.radius * 0.5) return false;
  if (d < 1e-6) return true;
  // yaw 0 faces +z
  const fx = Math.sin(seeker.yaw);
  const fz = Math.cos(seeker.yaw);
  const cos = (dx * fx + dz * fz) / d;
  return cos >= Math.cos(((CARD.tagConeDeg / 2) * Math.PI) / 180);
}

/** Server check on the origin a kick claims (it must be where the seeker really is, within half a metre). */
export function kickOriginOk(seeker: Point2, origin: Point2): boolean {
  const dx = origin.x - seeker.x;
  const dz = origin.z - seeker.z;
  return dx * dx + dz * dz <= CARD.kickOriginSlack * CARD.kickOriginSlack;
}

export function inForbiddenZone(room: Pick<CamoRoomData, 'forbidden'>, p: Point2): boolean {
  return room.forbidden.some((f) => insideAabb2d(p.x, p.z, f));
}

/** Eye-level sight between two points, in a half-plane of `fovDeg` around `yaw` when given. */
export function canSee(
  room: CamoRoomData,
  from: Point2 & { yaw?: number },
  to: Point2,
  maxRange: number,
  fovDeg = 360,
): boolean {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > maxRange) return false;
  if (fovDeg < 360 && from.yaw !== undefined && d > 1e-6) {
    const cos = (dx * Math.sin(from.yaw) + dz * Math.cos(from.yaw)) / d;
    if (cos < Math.cos(((fovDeg / 2) * Math.PI) / 180)) return false;
  }
  return !lineBlocked(room, from.x, from.z, to.x, to.z);
}

/** The most distance a body may cover between two moves (speed limit with slack and a teleport allowance). */
export function travelBudget(dtMs: number, running: boolean): number {
  const speed = running ? MOVE.seekerRun : MOVE.walk;
  return speed * MOVE.slack * Math.min(MOVE.maxCreditS, Math.max(0, dtMs) / 1000) + MOVE.teleportSlack;
}
