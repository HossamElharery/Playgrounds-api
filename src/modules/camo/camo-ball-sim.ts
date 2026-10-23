/**
 * The seeker's football: one pure, deterministic simulation shared by the server (which decides) and the client
 * (which predicts and then blends to the server's path). Fixed 120 Hz substeps, integer-free but only uses IEEE basic
 * operations and sqrt, so both sides produce the same numbers; `camo-ball-sim.fixture.json` proves it.
 *
 * Hiders are vertical cylinders (equal for everybody). The ball does not collide with a hider until the hit is
 * confirmed: the first contact is reported as an event and only then does the ball bounce off.
 */
import { HIT_VOLUME } from './camo-constants';
import { RESTITUTION, type CamoRoomData, type SurfaceMaterial } from './camo-room';

export const BALL_RADIUS = 0.15;
export const BALL_GRAVITY = 9.8;
export const BALL_AIR_DRAG = 0.06;
export const BALL_ROLL_DECEL = 1.8;
export const BALL_REST_SPEED = 0.12;
export const BALL_SUBSTEP = 1 / 120;
export const BALL_MAX_TIME = 4;
/** Impacts keep this share of the speed along the surface (friction). */
const TANGENT_KEEP = 0.9;
const HIDER_BOUNCE = 0.35;
/** Floor material of a room (a slab at y = 0). */
export const FLOOR_MATERIAL: SurfaceMaterial = 'tile';

export interface BallState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface CylinderTarget {
  /** Index handed back in the hit events. */
  id: number;
  x: number;
  z: number;
  /** The body's radius and height when it is not the standard hider (a hider disguised as a prop). */
  r?: number;
  h?: number;
}

export type BallEventKind = 'bounce' | 'hit' | 'stop';

export interface BallEvent {
  kind: BallEventKind;
  /** Seconds since the kick. */
  t: number;
  x: number;
  y: number;
  z: number;
  material?: SurfaceMaterial;
  /** `hit`: which target. */
  target?: number;
  /** `hit`: the ball had already bounced off the room (a ricochet: «اتمسك بالغلط»). */
  ricochet?: boolean;
  /** Impact speed, used for the sound volume. */
  speed?: number;
}

export interface BallKeyframe {
  t: number;
  x: number;
  y: number;
  z: number;
}

export interface ShotResult {
  events: BallEvent[];
  keyframes: BallKeyframe[];
  end: { t: number; x: number; y: number; z: number };
  /** Distance of the first hit from the origin (metres), 0 when none. */
  firstHitDistance: number;
}

const norm = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.sqrt(x * x + y * y + z * z);
  return l > 1e-9 ? [x / l, y / l, z / l] : [0, 0, 1];
};

/** Launch velocity of a kick: a direct shot or a lob (section 5.2). */
export function launchVelocity(
  dx: number,
  dy: number,
  dz: number,
  power: number,
  lob: boolean,
  shotSpeed = 22,
  lobMax = 14,
): [number, number, number] {
  const p = Math.min(1, Math.max(0, Number.isFinite(power) ? power : 0));
  if (!lob) {
    const [x, y, z] = norm(dx, Math.max(-0.5, Math.min(0.5, dy)), dz);
    return [x * shotSpeed, y * shotSpeed, z * shotSpeed];
  }
  // Lob: always lofted at 55 degrees along the horizontal aim, 6..14 m/s by how long the thumb stayed down.
  const hl = Math.sqrt(dx * dx + dz * dz) || 1;
  const speed = 6 + (lobMax - 6) * p;
  const elev = (55 * Math.PI) / 180;
  const h = Math.cos(elev) * speed;
  return [(dx / hl) * h, Math.sin(elev) * speed, (dz / hl) * h];
}

/** Whether a ball sphere touches a hider cylinder, and the horizontal push direction. */
function touchesCylinder(b: BallState, c: CylinderTarget): { nx: number; nz: number } | null {
  const dx = b.x - c.x;
  const dz = b.z - c.z;
  const r = (c.r ?? HIT_VOLUME.radius) + BALL_RADIUS;
  const d2 = dx * dx + dz * dz;
  if (d2 > r * r) return null;
  if (b.y < -BALL_RADIUS || b.y > (c.h ?? HIT_VOLUME.height) + BALL_RADIUS) return null;
  const d = Math.sqrt(d2);
  return d > 1e-6 ? { nx: dx / d, nz: dz / d } : { nx: 1, nz: 0 };
}

/**
 * Flies one ball from `origin` until it rests, leaves the world or runs out of time.
 * `targets` are the hiders that can still be hit; each is hit at most once.
 */
export function simulateShot(
  room: Pick<CamoRoomData, 'colliders' | 'bounds'>,
  origin: { x: number; y: number; z: number },
  velocity: readonly [number, number, number],
  targets: readonly CylinderTarget[],
  keyframeEvery = 0.05,
): ShotResult {
  const b: BallState = { x: origin.x, y: origin.y, z: origin.z, vx: velocity[0], vy: velocity[1], vz: velocity[2] };
  const events: BallEvent[] = [];
  const keyframes: BallKeyframe[] = [{ t: 0, x: b.x, y: b.y, z: b.z }];
  const live = targets.slice();
  let bounced = false;
  let t = 0;
  let nextKey = keyframeEvery;
  let firstHit = 0;
  const dt = BALL_SUBSTEP;
  const steps = Math.floor(BALL_MAX_TIME / dt);
  for (let i = 0; i < steps; i++) {
    t = (i + 1) * dt;
    b.vy -= BALL_GRAVITY * dt;
    const drag = 1 - BALL_AIR_DRAG * dt;
    b.vx *= drag;
    b.vy *= drag;
    b.vz *= drag;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;

    // Floor.
    if (b.y < BALL_RADIUS) {
      b.y = BALL_RADIUS;
      if (b.vy < -0.6) {
        const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
        b.vy = -b.vy * RESTITUTION[FLOOR_MATERIAL];
        b.vx *= TANGENT_KEEP;
        b.vz *= TANGENT_KEEP;
        bounced = true;
        events.push({ kind: 'bounce', t, x: b.x, y: b.y, z: b.z, material: FLOOR_MATERIAL, speed });
      } else {
        b.vy = 0;
        const h = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
        if (h > 0) {
          const k = Math.max(0, h - BALL_ROLL_DECEL * dt) / h;
          b.vx *= k;
          b.vz *= k;
        }
      }
    }

    // Boxes (lockers, benches, walls, props): sphere against AABB.
    for (const c of room.colliders) {
      if (b.y - BALL_RADIUS > c.maxY || b.y + BALL_RADIUS < c.minY) continue;
      const cx = Math.min(c.maxX, Math.max(c.minX, b.x));
      const cy = Math.min(c.maxY, Math.max(c.minY, b.y));
      const cz = Math.min(c.maxZ, Math.max(c.minZ, b.z));
      let nx = b.x - cx;
      let ny = b.y - cy;
      let nz = b.z - cz;
      const d2 = nx * nx + ny * ny + nz * nz;
      if (d2 >= BALL_RADIUS * BALL_RADIUS) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-9) {
        // centre inside the box: leave along the shallowest axis
        const l = b.x - c.minX;
        const r = c.maxX - b.x;
        const f = b.z - c.minZ;
        const n2 = c.maxZ - b.z;
        const u = c.maxY - b.y;
        const m = Math.min(l, r, f, n2, u);
        nx = ny = nz = 0;
        if (m === l) nx = -1;
        else if (m === r) nx = 1;
        else if (m === f) nz = -1;
        else if (m === n2) nz = 1;
        else ny = 1;
        d = 0;
        b.x += nx * (m + BALL_RADIUS);
        b.y += ny * (m + BALL_RADIUS);
        b.z += nz * (m + BALL_RADIUS);
      } else {
        nx /= d;
        ny /= d;
        nz /= d;
        const push = BALL_RADIUS - d;
        b.x += nx * push;
        b.y += ny * push;
        b.z += nz * push;
      }
      const vn = b.vx * nx + b.vy * ny + b.vz * nz;
      if (vn < 0) {
        const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
        const e = RESTITUTION[c.material];
        // reflect the normal part, damp the rest
        b.vx = (b.vx - vn * nx) * TANGENT_KEEP - e * vn * nx;
        b.vy = (b.vy - vn * ny) * TANGENT_KEEP - e * vn * ny;
        b.vz = (b.vz - vn * nz) * TANGENT_KEEP - e * vn * nz;
        bounced = true;
        if (-vn > 0.8) events.push({ kind: 'bounce', t, x: b.x, y: b.y, z: b.z, material: c.material, speed });
      }
    }

    // Hiders: report the first touch of each, then bounce off like a soft body.
    for (let k = live.length - 1; k >= 0; k--) {
      const touch = touchesCylinder(b, live[k]);
      if (!touch) continue;
      events.push({ kind: 'hit', t, x: b.x, y: b.y, z: b.z, target: live[k].id, ricochet: bounced });
      if (!firstHit) firstHit = Math.sqrt((b.x - origin.x) ** 2 + (b.z - origin.z) ** 2);
      live.splice(k, 1);
      const vn = b.vx * touch.nx + b.vz * touch.nz;
      if (vn < 0) {
        b.vx -= (1 + HIDER_BOUNCE) * vn * touch.nx;
        b.vz -= (1 + HIDER_BOUNCE) * vn * touch.nz;
      }
    }

    if (t >= nextKey) {
      keyframes.push({ t, x: b.x, y: b.y, z: b.z });
      nextKey += keyframeEvery;
    }
    if (b.y <= BALL_RADIUS + 1e-6 && b.vy === 0 && b.vx * b.vx + b.vz * b.vz < BALL_REST_SPEED * BALL_REST_SPEED) {
      events.push({ kind: 'stop', t, x: b.x, y: b.y, z: b.z });
      break;
    }
  }
  keyframes.push({ t, x: b.x, y: b.y, z: b.z });
  return { events, keyframes, end: { t, x: b.x, y: b.y, z: b.z }, firstHitDistance: firstHit };
}
