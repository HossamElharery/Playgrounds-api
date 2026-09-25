/** Walkable disc of the lobby floor (scene units). Mirrors the client's WALK_RADIUS. */
export const LOBBY_WALK_RADIUS = 8.2;
/** Run speed 4.0 u/s + 15 % slack. */
export const LOBBY_MAX_SPEED = 4.6;
/** Teleport allowance: `maxSpeed × dt × 1.5 + 0.5`. */
export const LOBBY_SPEED_SLACK = 1.5;
export const LOBBY_TELEPORT_SLACK = 0.5;
/** Unused travel time carried between messages is capped here (see LobbyWorldService). */
export const LOBBY_MAX_CREDIT_S = 1;

export type LobbyMoveMode = 0 | 1 | 2 | 3;

/** A `lobby.move` payload after validation, rounded like the wire format. */
export interface LobbyMove {
  squadId: string;
  seq: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  h: number;
  m: LobbyMoveMode;
  tx?: number;
  tz?: number;
}

const MAX_ID = 64;

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Heading into (−π, π]. */
export function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  let r = a % t;
  if (r <= -Math.PI) r += t;
  else if (r > Math.PI) r -= t;
  return r;
}

/** Clamp a point to the walkable disc. */
export function clampToDisc(
  x: number,
  z: number,
  r = LOBBY_WALK_RADIUS,
): { x: number; z: number } {
  const d = Math.hypot(x, z);
  if (d <= r) return { x, z };
  const k = r / d;
  return { x: x * k, z: z * k };
}

/**
 * Shape check + clamps for a client `lobby.move`. Returns null for anything
 * malformed (wrong types, non-finite numbers, unknown mode): the message is
 * dropped silently. Positions are clamped to the disc, velocity to
 * LOBBY_MAX_SPEED, the heading wrapped; a stop (`m: 0`) carries zero velocity.
 */
export function parseLobbyMove(data: unknown): LobbyMove | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const squadId = d['squadId'];
  if (typeof squadId !== 'string' || !squadId || squadId.length > MAX_ID)
    return null;
  const { seq, x, z, vx, vz, h, m } = d;
  if (!finite(seq) || !finite(x) || !finite(z) || !finite(h)) return null;
  if (!finite(vx) || !finite(vz)) return null;
  if (m !== 0 && m !== 1 && m !== 2 && m !== 3) return null;
  const pos = clampToDisc(x, z);
  let velX = m === 0 ? 0 : vx;
  let velZ = m === 0 ? 0 : vz;
  const speed = Math.hypot(velX, velZ);
  if (speed > LOBBY_MAX_SPEED) {
    velX *= LOBBY_MAX_SPEED / speed;
    velZ *= LOBBY_MAX_SPEED / speed;
  }
  const move: LobbyMove = {
    squadId,
    seq: Math.trunc(seq) >>> 0,
    x: round2(pos.x),
    z: round2(pos.z),
    vx: round2(velX),
    vz: round2(velZ),
    h: round3(wrapAngle(h)),
    m,
  };
  const { tx, tz } = d;
  if (finite(tx) && finite(tz)) {
    const target = clampToDisc(tx, tz);
    move.tx = round2(target.x);
    move.tz = round2(target.z);
  }
  return move;
}

/** A kick direction shorter than this carries no direction: dropped. */
const MIN_KICK_DIR = 0.01;

/**
 * Shape check for a client `lobby.ball.kick` ({ squadId, seq, dirX, dirZ,
 * power, px, pz }): a finite direction (normalized here), power clamped to
 * [0, 1]. Null for anything malformed. The client's px/pz are not trusted:
 * reach, cooldown and the goal freeze are checked by LobbyWorldService
 * against its own last accepted position.
 */
export function parseLobbyKick(data: unknown): {
  squadId: string;
  seq: number;
  dirX: number;
  dirZ: number;
  power: number;
} | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const squadId = d['squadId'];
  if (typeof squadId !== 'string' || !squadId || squadId.length > MAX_ID)
    return null;
  const { seq, dirX, dirZ, power } = d;
  if (!finite(seq) || !finite(dirX) || !finite(dirZ) || !finite(power))
    return null;
  const len = Math.hypot(dirX, dirZ);
  if (!(len >= MIN_KICK_DIR)) return null;
  return {
    squadId,
    seq: Math.trunc(seq) >>> 0,
    dirX: dirX / len,
    dirZ: dirZ / len,
    power: Math.min(1, Math.max(0, power)),
  };
}

/** uint32 serial-number order: true when `a` comes after `b` (wraparound safe). */
export function seqAfter(a: number, b: number): boolean {
  const diff = (a - b) >>> 0;
  return diff !== 0 && diff < 0x80000000;
}
