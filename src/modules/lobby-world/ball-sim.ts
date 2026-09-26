/*
 * Lobby World ball — the pure, deterministic simulation shared by the server
 * (authority) and the client (kicker prediction, extrapolation).
 *
 * MIRRORED FILE: the same logic lives in
 *   - Playgrounds      src/app/shared/squad/world/ball-sim.ts
 *   - Playgrounds-api  src/modules/lobby-world/ball-sim.ts
 * Both test suites replay ball-sim.fixture.json and must produce the same
 * numbers (the parity test). Change both together and regenerate the fixture.
 *
 * Units: scene units (≈ metres), seconds. Floor at y = 0; the walkable disc is
 * r ≤ 8.2 and the goal sits at the far (−z) edge, mouth facing +z.
 */

export const BALL_RADIUS = 0.22;
export const BALL_GRAVITY = 9.8;
/** Vertical bounce on the floor; below BALL_BOUNCE_STOP m/s it stops bouncing. */
export const BALL_GROUND_RESTITUTION = 0.5;
export const BALL_BOUNCE_STOP = 0.2;
/** Rolling friction on the floor (u/s²) and linear air drag (1/s). */
export const BALL_ROLL_DECEL = 1.8;
export const BALL_AIR_DRAG = 0.08;
export const BALL_WALL_RADIUS = 8.2;
export const BALL_WALL_RESTITUTION = 0.6;
export const BALL_POST_RESTITUTION = 0.7;
export const BALL_PLAYER_RESTITUTION = 0.35;
/** Tangential speed kept when the ball hits the net (the normal part is absorbed). */
export const BALL_NET_KEEP = 0.4;
/** A ball on the roof net is pushed back toward the mouth (the net sags), so it never rests up there. */
export const BALL_ROOF_ROLL = 3;
/** Resting: on the floor, slower than this. */
export const BALL_REST_SPEED = 0.03;
/** Most travel per substep (keeps a 12 u/s shot from tunnelling through a post). */
const MAX_STEP_TRAVEL = 0.08;
const MAX_SUBSTEPS = 16;

export const GOAL_LINE_Z = -7.1;
export const GOAL_BACK_Z = -8.1;
export const GOAL_HALF_WIDTH = 1.2;
export const GOAL_HEIGHT = 1.1;
export const GOAL_POST_RADIUS = 0.06;
/** The keeper's box in front of (and inside) the goal. */
export const GOAL_AREA_HALF_WIDTH = 2.2;
export const GOAL_AREA_FRONT_Z = GOAL_LINE_Z + 1.8;

export const KICK_BASE_SPEED = 3;
export const KICK_POWER_SPEED = 9;
export const KICK_CHIP_POWER = 0.85;
/** Full-power chip peaks ≈ 0.88 m above the floor rest height: it can reach the 1.1 m crossbar. */
export const KICK_CHIP_LIFT = 4.23;
/** Save radius multiplier for the keeper morph inside the goal area (easter egg). */
export const KEEPER_SAVE_SCALE = 1.6;

/** Event bits returned by stepBall. */
export const BALL_EVENT_GOAL = 1;
export const BALL_EVENT_POST = 2;
export const BALL_EVENT_BAR = 4;
export const BALL_EVENT_WALL = 8;
export const BALL_EVENT_NET = 16;
export const BALL_EVENT_TOUCH = 32;

export interface BallState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface BallPlayer {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Contact radius (body radius; × KEEPER_SAVE_SCALE for a keeper in the goal area). */
  r: number;
}

export interface BallStepInfo {
  /** Index into `players` of the last one that touched the ball this step, −1 if none. */
  toucher: number;
}

/**
 * Axis-aligned solid the ball bounces off (the booking kiosk). Omitted — the
 * default — the step is identical to the shared fixture.
 */
export interface BallAabb {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  maxY: number;
}

export function createBall(): BallState {
  return { x: 0, y: BALL_RADIUS, z: 0, vx: 0, vy: 0, vz: 0 };
}

/** Back to the centre spot, dropped from a little height (it bounces in). */
export function resetBall(b: BallState, dropHeight = 1.2): void {
  b.x = 0;
  b.z = 0;
  b.y = Math.max(BALL_RADIUS, dropHeight);
  b.vx = b.vy = b.vz = 0;
}

export function ballOnGround(b: BallState): boolean {
  return b.y <= BALL_RADIUS + 1e-6 && b.vy === 0;
}

export function ballResting(b: BallState): boolean {
  return ballOnGround(b) && hypot2(b.vx, b.vz) < BALL_REST_SPEED;
}

/** Is (x, z) inside the keeper's box? */
export function inGoalArea(x: number, z: number): boolean {
  return (
    Math.abs(x) <= GOAL_AREA_HALF_WIDTH &&
    z <= GOAL_AREA_FRONT_Z &&
    z >= GOAL_BACK_Z
  );
}

/**
 * A kick along (dirX, dirZ) with power 0..1: speed = 3 + 9 × power; above 0.85
 * it is a chip (+4.23 u/s up). Returns false for a zero direction (no kick).
 */
export function kickBall(
  b: BallState,
  dirX: number,
  dirZ: number,
  power: number,
): boolean {
  const len = hypot2(dirX, dirZ);
  if (!(len > 1e-6) || !Number.isFinite(len)) return false;
  const p = Math.min(1, Math.max(0, Number.isFinite(power) ? power : 0));
  const speed = KICK_BASE_SPEED + KICK_POWER_SPEED * p;
  b.vx = (dirX / len) * speed;
  b.vz = (dirZ / len) * speed;
  if (p > KICK_CHIP_POWER) b.vy = KICK_CHIP_LIFT;
  else if (ballOnGround(b)) b.vy = 0;
  return true;
}

/**
 * Advance the ball by `dt` seconds against the floor, the wall, the goal
 * (posts and crossbar bounce, the net absorbs) and `count` players (circles:
 * walking into the ball pushes it — that is dribbling). Returns the event bits;
 * BALL_EVENT_GOAL fires on the substep the ball gets fully across the goal
 * line between the posts and under the bar, however it got there.
 */
export function stepBall(
  b: BallState,
  players: readonly BallPlayer[],
  count: number,
  dt: number,
  info?: BallStepInfo,
  boxes?: readonly BallAabb[],
): number {
  if (info) info.toucher = -1;
  if (!(dt > 0)) return 0;
  const speed = hypot3(b.vx, b.vy, b.vz);
  const n = Math.min(
    MAX_SUBSTEPS,
    Math.max(1, Math.ceil((speed * dt) / MAX_STEP_TRAVEL)),
  );
  STEP.h = dt / n;
  STEP.boxes = boxes && boxes.length ? boxes : null;
  let events = 0;
  for (let i = 0; i < n; i++) events |= substep(b, players, count, info);
  STEP.boxes = null;
  return events;
}

/**
 * Per-substep numbers for substep() and goal(). They are too big to inline,
 * and doubles passed as arguments to a call that is not inlined are boxed (a
 * heap allocation each): fields of one reused object are not.
 */
const STEP: {
  h: number;
  px: number;
  py: number;
  pz: number;
  boxes: readonly BallAabb[] | null;
} = { h: 0, px: 0.5, py: 0.5, pz: 0.5, boxes: null };

function substep(
  b: BallState,
  players: readonly BallPlayer[],
  count: number,
  info: BallStepInfo | undefined,
): number {
  const h = STEP.h;
  const R = BALL_RADIUS;
  let events = 0;
  const airborne = b.y > R + 1e-6 || b.vy > 0;
  if (airborne) {
    b.vy -= BALL_GRAVITY * h;
    const drag = 1 - BALL_AIR_DRAG * h;
    b.vx *= drag;
    b.vy *= drag;
    b.vz *= drag;
  }
  const px = b.x;
  const py = b.y;
  const pz = b.z;
  STEP.px = px;
  STEP.py = py;
  STEP.pz = pz;
  b.x += b.vx * h;
  b.y += b.vy * h;
  b.z += b.vz * h;

  // Floor.
  if (b.y < R) {
    b.y = R;
    if (b.vy < 0) {
      b.vy = -b.vy * BALL_GROUND_RESTITUTION;
      if (b.vy < BALL_BOUNCE_STOP) b.vy = 0;
    }
  }
  if (b.y <= R + 1e-6 && b.vy === 0) {
    const hs = hypot2(b.vx, b.vz);
    const dec = BALL_ROLL_DECEL * h;
    if (hs <= dec) {
      b.vx = 0;
      b.vz = 0;
    } else {
      const k = (hs - dec) / hs;
      b.vx *= k;
      b.vz *= k;
    }
  }

  // Players (low balls only): push out and bounce off their motion.
  if (b.y < 1.2) {
    for (let i = 0; i < count; i++) {
      const p = players[i];
      const dx = b.x - p.x;
      const dz = b.z - p.z;
      const min = p.r + R;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) continue;
      let nx: number;
      let nz: number;
      const d = Math.sqrt(d2);
      if (d > 1e-6) {
        nx = dx / d;
        nz = dz / d;
      } else {
        const v = hypot2(p.vx, p.vz);
        nx = v > 1e-6 ? p.vx / v : 0;
        nz = v > 1e-6 ? p.vz / v : 1;
      }
      b.x = p.x + nx * min;
      b.z = p.z + nz * min;
      const rel = (b.vx - p.vx) * nx + (b.vz - p.vz) * nz;
      if (rel < 0) {
        b.vx -= (1 + BALL_PLAYER_RESTITUTION) * rel * nx;
        b.vz -= (1 + BALL_PLAYER_RESTITUTION) * rel * nz;
      }
      events |= BALL_EVENT_TOUCH;
      if (info) info.toucher = i;
    }
  }

  // Optional solids (the kiosk). Skipped entirely when none were passed in,
  // so the shared fixture path does not move.
  if (STEP.boxes) events |= collideBoxes(b);

  // Posts and net see the whole move, player pushes included.
  events |= goal(b);

  // The wall of the walkable disc (the ball's surface stays inside it).
  const lim = BALL_WALL_RADIUS - R;
  const r = hypot2(b.x, b.z);
  if (r > lim) {
    const nx = b.x / r;
    const nz = b.z / r;
    b.x = nx * lim;
    b.z = nz * lim;
    const vn = b.vx * nx + b.vz * nz;
    if (vn > 0) {
      b.vx -= (1 + BALL_WALL_RESTITUTION) * vn * nx;
      b.vz -= (1 + BALL_WALL_RESTITUTION) * vn * nz;
    }
    events |= BALL_EVENT_WALL;
    // Behind the goal line the gap between a side net's outside and the wall
    // is narrower than the ball: the net wins and the ball slides forward along
    // it (inside the wall), instead of being squeezed through into the goal.
    const hw = GOAL_HALF_WIDTH;
    const ax = Math.abs(b.x);
    if (
      ax > hw &&
      ax < hw + R &&
      b.z < GOAL_LINE_Z &&
      b.z > GOAL_BACK_Z - R &&
      b.y < GOAL_HEIGHT + R
    ) {
      const sx = b.x < 0 ? -1 : 1;
      b.x = sx * (hw + R);
      b.z = Math.max(b.z, -Math.sqrt(Math.max(0, lim * lim - b.x * b.x)));
      if (sx * b.vx < 0) b.vx = 0;
      if (b.vz < 0) b.vz = 0;
    }
  }

  // Settle: a slow rolling ball stops dead (no endless creep).
  if (b.y <= R + 1e-6 && b.vy === 0 && hypot2(b.vx, b.vz) < BALL_REST_SPEED) {
    b.vx = 0;
    b.vz = 0;
  }

  // Goal: the ball got fully into the goal this substep — judged after every
  // push and bounce, so however it went in (a shot, a body walking it over the
  // line) it scores, and it can never sit in the goal unscored.
  if (!inGoalMouth(px, py, pz) && inGoalMouth(b.x, b.y, b.z))
    events |= BALL_EVENT_GOAL;
  return events;
}

/** Posts, crossbar and net against the ball; also detects the goal-line crossing. */
/** Push the ball out of the shallowest side of each solid and bounce. */
function collideBoxes(b: BallState): number {
  const boxes = STEP.boxes;
  if (!boxes) return 0;
  const R = BALL_RADIUS;
  let events = 0;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (b.y > box.maxY + R) continue;
    if (b.x < box.minX - R || b.x > box.maxX + R) continue;
    if (b.z < box.minZ - R || b.z > box.maxZ + R) continue;
    const left = b.x - (box.minX - R);
    const right = box.maxX + R - b.x;
    const front = b.z - (box.minZ - R);
    const back = box.maxZ + R - b.z;
    const min = Math.min(left, right, front, back);
    if (min === left) {
      b.x = box.minX - R;
      if (b.vx > 0) b.vx = -b.vx * BALL_WALL_RESTITUTION;
    } else if (min === right) {
      b.x = box.maxX + R;
      if (b.vx < 0) b.vx = -b.vx * BALL_WALL_RESTITUTION;
    } else if (min === front) {
      b.z = box.minZ - R;
      if (b.vz > 0) b.vz = -b.vz * BALL_WALL_RESTITUTION;
    } else {
      b.z = box.maxZ + R;
      if (b.vz < 0) b.vz = -b.vz * BALL_WALL_RESTITUTION;
    }
    events |= BALL_EVENT_WALL;
  }
  return events;
}

function goal(b: BallState): number {
  const { h, px, py, pz } = STEP;
  const R = BALL_RADIUS;
  const hw = GOAL_HALF_WIDTH;
  const top = GOAL_HEIGHT;
  const line = GOAL_LINE_Z;
  const back = GOAL_BACK_Z;
  let events = 0;

  // Posts: vertical cylinders at the front corners.
  if (b.y - R < top) {
    for (let s = -1; s <= 1; s += 2) {
      const dx = b.x - s * hw;
      const dz = b.z - line;
      const min = GOAL_POST_RADIUS + R;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 1e-6;
      const nx = dx / d;
      const nz = dz / d;
      b.x = s * hw + nx * min;
      b.z = line + nz * min;
      const vn = b.vx * nx + b.vz * nz;
      if (vn < 0) {
        b.vx -= (1 + BALL_POST_RESTITUTION) * vn * nx;
        b.vz -= (1 + BALL_POST_RESTITUTION) * vn * nz;
      }
      events |= BALL_EVENT_POST;
    }
  }

  // Crossbar: a horizontal cylinder along x at (y = top, z = line). A ball
  // riding over the roof net (above the bar, not past the line yet) treats the
  // bar as the roof's edge and rolls off, instead of balancing on its crest.
  if (Math.abs(b.x) <= hw && !(py >= top && pz <= line)) {
    const dy = b.y - top;
    const dz = b.z - line;
    const min = GOAL_POST_RADIUS + R;
    const d2 = dy * dy + dz * dz;
    if (d2 < min * min) {
      const d = Math.sqrt(d2) || 1e-6;
      const ny = dy / d;
      const nz = dz / d;
      b.y = top + ny * min;
      b.z = line + nz * min;
      const vn = b.vy * ny + b.vz * nz;
      if (vn < 0) {
        b.vy -= (1 + BALL_POST_RESTITUTION) * vn * ny;
        b.vz -= (1 + BALL_POST_RESTITUTION) * vn * nz;
      }
      events |= BALL_EVENT_BAR;
    }
  }

  // Net: sides, back and roof absorb (from inside and from outside). Which
  // side of a side net the ball came from is where it crossed the goal line
  // (a ball from in front, pushed past the post line, meets the net outside).
  const inDepth = b.z < line && b.z > back - R;
  const inHeight = b.y < top + R;
  const fromX =
    pz >= line && b.z < line
      ? px + ((b.x - px) * (pz - line)) / (pz - b.z)
      : px;
  for (let s = -1; s <= 1; s += 2) {
    const wall = s * hw;
    if (!inDepth || !inHeight) continue;
    const wasInside = s * fromX < hw;
    if (wasInside && s * (b.x + s * R) > hw) {
      b.x = wall - s * R;
      if (s * b.vx > 0) b.vx = 0;
      b.vz *= BALL_NET_KEEP;
      b.vy *= BALL_NET_KEEP;
      events |= BALL_EVENT_NET;
    } else if (!wasInside && s * (b.x - s * R) < hw) {
      b.x = wall + s * R;
      if (s * b.vx < 0) b.vx = 0;
      b.vz *= BALL_NET_KEEP;
      events |= BALL_EVENT_NET;
    }
  }
  if (Math.abs(b.x) < hw && b.y < top + R) {
    if (pz > back && b.z - R < back) {
      b.z = back + R;
      if (b.vz < 0) b.vz = 0;
      b.vx *= BALL_NET_KEEP;
      b.vy *= BALL_NET_KEEP;
      events |= BALL_EVENT_NET;
    } else if (pz < back && b.z + R > back) {
      b.z = back - R;
      if (b.vz > 0) b.vz = 0;
      events |= BALL_EVENT_NET;
    }
  }
  if (Math.abs(b.x) < hw && b.z < line && b.z > back) {
    if (py < top && b.y + R > top) {
      // Roof from inside.
      b.y = top - R;
      if (b.vy > 0) b.vy = 0;
      events |= BALL_EVENT_NET;
    } else if (py >= top && b.y - R < top) {
      // On the roof: absorbed, then rolls back off the mouth (never rests up there).
      b.y = top + R;
      if (b.vy < 0) b.vy = 0;
      b.vx *= BALL_NET_KEEP;
      b.vz = Math.max(b.vz, 0) + BALL_ROOF_ROLL * h;
      events |= BALL_EVENT_NET;
    }
  }
  return events;
}

/** Fully across the goal line, between the posts, under the bar. */
function inGoalMouth(x: number, y: number, z: number): boolean {
  return (
    Math.abs(x) < GOAL_HALF_WIDTH &&
    z <= GOAL_LINE_Z - BALL_RADIUS &&
    y < GOAL_HEIGHT
  );
}

/** `Math.hypot` is not inlined by the JIT and allocates per call: the sim runs every frame (and every server tick). */
function hypot2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

function hypot3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}
