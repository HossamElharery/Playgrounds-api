/**
 * Hits and sight: pure geometry for tags, forbidden zones and who can see whom. The ball itself lives in
 * `camo-ball-sim.ts`; this file never produces a hit marker, it only answers questions the server asks.
 */
import { AIM_ASSIST, CARD, HIT_VOLUME, MOVE } from './camo-constants';
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

/**
 * Aim help for a human's direct shot: when a hider that the seeker could see at all stands within `coneDeg` of the line
 * of fire, the shot is turned onto that hider's chest. Walls still stop the ball, and a hider behind a wall is never
 * picked, so this tells nobody anything the seeker's eyes did not already allow.
 */
export function assistedDirection(
  room: CamoRoomData,
  from: { x: number; y: number; z: number },
  dir: readonly [number, number, number],
  hiders: ReadonlyArray<Point2>,
  cfg: { coneDeg: number; range: number; chestHeight: number } = AIM_ASSIST,
): [number, number, number] {
  const dl = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]) || 1;
  const ux = dir[0] / dl;
  const uy = dir[1] / dl;
  const uz = dir[2] / dl;
  const minCos = Math.cos((cfg.coneDeg * Math.PI) / 180);
  let best: [number, number, number] | null = null;
  let bestCos = minCos;
  for (const h of hiders) {
    const dx = h.x - from.x;
    const dy = cfg.chestHeight - from.y;
    const dz = h.z - from.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 0.4 || d > cfg.range) continue;
    const c = (dx * ux + dy * uy + dz * uz) / d;
    if (c < bestCos) continue;
    if (lineBlocked(room, from.x, from.z, h.x, h.z)) continue;
    bestCos = c;
    best = [dx / d, dy / d, dz / d];
  }
  return best ?? [ux, uy, uz];
}
