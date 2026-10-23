/**
 * The room builder shared by every «استغماية» room recipe. A recipe adds solid things (`item`), decoration that does
 * not block (`decor`) and asks for hiding places along the open sides of tall cover (`cover`); `finish` then nudges
 * every candidate onto free floor, drops the ones that sit in a forbidden zone, cannot be reached or crowd another
 * spot, and grades the rest by how exposed they are (1 easy to find .. 3 well tucked away). Pure: no Nest, no three.js.
 */
import {
  SURFACE_COLOR,
  WALL_H,
  WALL_T,
  boxOf,
  buildWalkGrid,
  insideAabb2d,
  isWalkable,
  lineBlocked,
  pushOut,
  reachableFrom,
  round,
  type Aabb,
  type CamoRoomData,
  type Collider,
  type HideSpot,
  type Prop,
  type Seat,
  type SurfaceMaterial,
} from './camo-room';

export interface ClutterDef {
  type: string;
  w: number;
  d: number;
  h: number;
  material: SurfaceMaterial;
  /** Relative frequency among the room's defs. */
  weight?: number;
}

export type Side = 'n' | 's' | 'e' | 'w';
const ALL_SIDES: readonly Side[] = ['n', 's', 'e', 'w'];

export interface CoverOpts {
  sides?: readonly Side[];
  /** Metres between two spots along a side. */
  spacing?: number;
  /** Distance from the surface to the body centre (a body is 0.3 m deep, so 0.42 leaves a hand's width). */
  offset?: number;
  kind?: HideSpot['kind'];
  poses?: string[];
  surface?: SurfaceMaterial;
  /** Keep only every n-th position (thin out a very long wall). */
  every?: number;
}

export interface ItemOpts {
  label?: string;
  ry?: number;
  /** Not a collider (a poster, a lantern, a hanging jersey). */
  solid?: boolean;
  y?: number;
  /** Ask for hiding places around it. */
  cover?: CoverOpts | boolean;
}

const TALL = ['stand', 'wall', 'lean_l', 'lean_r', 'bend'];
const LOW = ['crouch', 'ball', 'bend', 'sit'];
const CORNER = ['crouch', 'ball', 'flat', 'wall'];

export class RoomKit {
  readonly colliders: Collider[] = [];
  readonly props: Prop[] = [];
  readonly seats: Seat[] = [];
  private readonly candidates: HideSpot[] = [];
  private uid = 0;

  /** Wall height: a locker room is 4 m, a warehouse 12 m (the client reads it from the «walls» prop). */
  constructor(
    readonly bounds: CamoRoomData['bounds'],
    readonly height: number = WALL_H,
  ) {}

  private id(p: string): string {
    return `${p}${++this.uid}`;
  }

  solid(cid: string, a: Aabb, material: SurfaceMaterial): void {
    this.colliders.push({ id: cid, ...a, material });
  }

  prop(type: string, cx: number, cz: number, w: number, h: number, d: number, material: SurfaceMaterial, ry = 0, label?: string, y = h / 2): Prop {
    const p: Prop = { id: this.id(type), type, x: round(cx), y: round(y), z: round(cz), w, h, d, ry, material, ...(label ? { label } : {}) };
    this.props.push(p);
    return p;
  }

  /** The four outer walls (colliders just outside the walkable rectangle, plus the one «walls» prop the client reads). */
  walls(): void {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    this.solid('wall-n', { minX: minX - WALL_T, maxX: maxX + WALL_T, minZ: minZ - WALL_T, maxZ: minZ, minY: 0, maxY: this.height }, 'concrete');
    this.solid('wall-s', { minX: minX - WALL_T, maxX: maxX + WALL_T, minZ: maxZ, maxZ: maxZ + WALL_T, minY: 0, maxY: this.height }, 'concrete');
    this.solid('wall-w', { minX: minX - WALL_T, maxX: minX, minZ, maxZ, minY: 0, maxY: this.height }, 'concrete');
    this.solid('wall-e', { minX: maxX, maxX: maxX + WALL_T, minZ, maxZ, minY: 0, maxY: this.height }, 'concrete');
    this.prop('walls', 0, 0, maxX - minX, this.height, maxZ - minZ, 'concrete');
  }

  /** A solid box (collider + drawn prop), optionally with hiding places around it. */
  item(type: string, cx: number, cz: number, w: number, d: number, h: number, material: SurfaceMaterial, o: ItemOpts = {}): void {
    const ry = o.ry ?? 0;
    // a prop turned a quarter turn swaps its footprint
    const quarter = Math.abs(Math.sin(ry)) > 0.99;
    const fw = quarter ? d : w;
    const fd = quarter ? w : d;
    if (o.solid !== false) this.solid(this.id(type), boxOf(cx, cz, fw, fd, h), material);
    this.prop(type, cx, cz, w, h, d, material, ry, o.label, o.y);
    if (o.cover && o.solid !== false) this.cover(boxOf(cx, cz, fw, fd, h), { surface: material, ...(o.cover === true ? {} : o.cover) });
  }

  /** Decoration that nothing collides with (posters, lanterns, jerseys, signs). */
  decor(type: string, cx: number, cz: number, w: number, h: number, d: number, material: SurfaceMaterial, o: { ry?: number; label?: string; y?: number } = {}): void {
    this.prop(type, cx, cz, w, h, d, material, o.ry ?? 0, o.label, o.y);
  }

  seat(x: number, z: number, y: number, nx = 0, nz = 1): void {
    this.seats.push({ id: `seat${this.seats.length + 1}`, x: round(x), z: round(z), y, nx, nz });
  }

  /** One hiding place by hand. */
  spot(x: number, z: number, nx: number, nz: number, surface: SurfaceMaterial, poses: string[], kind: HideSpot['kind'], difficulty: 1 | 2 | 3 = 2): void {
    this.candidates.push({ id: `c${this.candidates.length + 1}`, x: round(x), z: round(z), nx, nz, surface, poses, difficulty, kind, color: SURFACE_COLOR[surface] });
  }

  /** Hiding places along the open sides of a box: the body stands `offset` from the surface with its back to it. */
  cover(box: Aabb, o: CoverOpts = {}): void {
    const sides = o.sides ?? ALL_SIDES;
    const spacing = o.spacing ?? 0.9;
    const offset = o.offset ?? 0.42;
    const height = box.maxY - box.minY;
    const tall = height >= 1.35;
    const poses = o.poses ?? (tall ? TALL : LOW);
    const kind: HideSpot['kind'] = o.kind ?? (tall ? 'wall' : 'prop');
    const surface = o.surface ?? 'concrete';
    const along = (a0: number, a1: number): number[] => {
      const len = a1 - a0;
      const n = Math.max(1, Math.round(len / spacing));
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push(a0 + ((i + 0.5) / n) * len);
      return out;
    };
    const keep = (i: number): boolean => i % (o.every ?? 1) === 0;
    for (const s of sides) {
      if (s === 'n') along(box.minX, box.maxX).forEach((x, i) => keep(i) && this.spot(x, box.minZ - offset, 0, -1, surface, poses, kind, tall ? 2 : 3));
      if (s === 's') along(box.minX, box.maxX).forEach((x, i) => keep(i) && this.spot(x, box.maxZ + offset, 0, 1, surface, poses, kind, tall ? 2 : 3));
      if (s === 'w') along(box.minZ, box.maxZ).forEach((z, i) => keep(i) && this.spot(box.minX - offset, z, -1, 0, surface, poses, kind, tall ? 2 : 3));
      if (s === 'e') along(box.minZ, box.maxZ).forEach((z, i) => keep(i) && this.spot(box.maxX + offset, z, 1, 0, surface, poses, kind, tall ? 2 : 3));
    }
  }

  /**
   * Scatters small things a person could become (crates, barrels, chairs ...) in clumps: each clump is a ring of the same
   * object with one place left empty, and that gap is a hiding place, so a hider who steps into it and copies its
   * neighbours completes the ring. Placement is deterministic from `seed`, keeps clear of everything already solid and of
   * the referees' door, and leaves lanes open.
   */
  clutter(rr: CamoRoomData['refereeRoom'], defs: readonly ClutterDef[], clumps: number, seed: number, avoid: ReadonlyArray<{ x: number; z: number }> = []): void {
    let st = seed >>> 0;
    const rnd = (): number => {
      st = (st + 0x6d2b79f5) >>> 0;
      let t = st;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const total = defs.reduce((t, d) => t + (d.weight ?? 1), 0);
    const taken: Aabb[] = [];
    const free = (a: Aabb): boolean => {
      if (a.minX < minX + 1.4 || a.maxX > maxX - 1.4 || a.minZ < minZ + 1.4 || a.maxZ > maxZ - 1.4) return false;
      if (a.maxX > rr.minX - 1.5 && a.minX < rr.maxX + 1.5 && a.maxZ > rr.minZ - 1.5 && a.minZ < rr.maxZ + 1.5) return false;
      if (Math.abs((a.minX + a.maxX) / 2 - rr.door.x) < 6 && Math.abs((a.minZ + a.maxZ) / 2 - rr.door.z) < 6) return false;
      if (avoid.some((v) => v.x > a.minX - 1.6 && v.x < a.maxX + 1.6 && v.z > a.minZ - 1.6 && v.z < a.maxZ + 1.6)) return false;
      const hit = (b: Aabb, m: number): boolean => a.maxX > b.minX - m && a.minX < b.maxX + m && a.maxZ > b.minZ - m && a.minZ < b.maxZ + m;
      return !this.colliders.some((c) => c.maxY > 0.3 && hit(c, 0.55)) && !taken.some((b) => hit(b, 0.18));
    };
    let placed = 0;
    for (let c = 0; c < clumps; c++) {
      let r = rnd() * total;
      let def = defs[0];
      for (const d of defs) {
        r -= d.weight ?? 1;
        if (r <= 0) {
          def = d;
          break;
        }
      }
      const slots = 4 + Math.floor(rnd() * 3);
      const size = Math.max(def.w, def.d);
      const ring = Math.max(size * 0.95, (size + 0.2) / (2 * Math.sin(Math.PI / slots)));
      for (let attempt = 0; attempt < 60; attempt++) {
        const cx = minX + 2 + rnd() * (maxX - minX - 4);
        const cz = minZ + 2 + rnd() * (maxZ - minZ - 4);
        const gap = Math.floor(rnd() * slots);
        const a0 = rnd() * Math.PI * 2;
        const boxes: Array<{ x: number; z: number; a: number; box: Aabb }> = [];
        for (let i = 0; i < slots; i++) {
          const a = a0 + (i / slots) * Math.PI * 2;
          const x = cx + Math.sin(a) * ring;
          const z = cz + Math.cos(a) * ring;
          boxes.push({ x, z, a, box: boxOf(x, z, size, size, def.h) });
        }
        if (!boxes.every((b) => free(b.box))) continue;
        boxes.forEach((b, i) => {
          if (i === gap) {
            this.spot(b.x, b.z, Math.sin(b.a), Math.cos(b.a), def.material, i % 2 ? LOW : TALL, 'prop', 3);
            return;
          }
          this.item(def.type, b.x, b.z, def.w, def.d, def.h, def.material, { ry: b.a + Math.PI / 2 * Math.round(rnd() * 3) });
          taken.push(b.box);
        });
        taken.push(boxOf(boxes[gap].x, boxes[gap].z, size, size, def.h));
        placed++;
        break;
      }
    }
    void placed;
  }

  /** The four corners of the hall: a body folded into the angle between two walls. */
  corners(inset = 0.5): void {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    this.spot(minX + inset, minZ + inset, 1, 1, 'concrete', CORNER, 'corner', 3);
    this.spot(maxX - inset, minZ + inset, -1, 1, 'concrete', CORNER, 'corner', 3);
    this.spot(minX + inset, maxZ - inset, 1, -1, 'concrete', CORNER, 'corner', 3);
    this.spot(maxX - inset, maxZ - inset, -1, -1, 'concrete', CORNER, 'corner', 3);
  }

  /** A run of positions along one wall of the hall (the plain wall between props). */
  wallRun(side: Side, from: number, to: number, spacing = 1.2, surface: SurfaceMaterial = 'concrete'): void {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const n = Math.max(1, Math.floor((to - from) / spacing));
    for (let i = 0; i <= n; i++) {
      const a = from + (i / Math.max(1, n)) * (to - from);
      if (side === 'n') this.spot(a, minZ + 0.45, 0, 1, surface, TALL, 'wall', 2);
      if (side === 's') this.spot(a, maxZ - 0.45, 0, -1, surface, TALL, 'wall', 2);
      if (side === 'w') this.spot(minX + 0.45, a, 1, 0, surface, TALL, 'wall', 2);
      if (side === 'e') this.spot(maxX - 0.45, a, -1, 0, surface, TALL, 'wall', 2);
    }
  }

  /** The referees' room in a corner: a box with one door facing the hall. Returns the room and the three waiting places. */
  refereeRoom(corner: 'sw' | 'se' | 'nw' | 'ne' = 'sw'): CamoRoomData['refereeRoom'] {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const w = 5;
    const d = 4;
    const west = corner === 'sw' || corner === 'nw';
    const south = corner === 'sw' || corner === 'se';
    const x0 = west ? minX : maxX - w;
    const z0 = south ? maxZ - d : minZ;
    // the door sits at the end of its wall that is nearer the middle of the hall
    const doorX = west ? x0 + w - 1.5 : x0 + 1.5;
    // the door is in the wall that faces the hall: the north wall of a southern room (the common case)
    const doorZ = south ? z0 : z0 + d;
    const rr: CamoRoomData['refereeRoom'] = { minX: x0, maxX: x0 + w, minZ: z0, maxZ: z0 + d, minY: 0, maxY: WALL_H, door: { x: doorX, z: doorZ } };
    const t = 0.2;
    const hallZ = south ? rr.minZ : rr.maxZ - t;
    this.solid('ref-n', { minX: rr.minX, maxX: doorX - 0.6, minZ: hallZ, maxZ: hallZ + t, minY: 0, maxY: 2.6 }, 'wood');
    this.solid('ref-n2', { minX: doorX + 0.6, maxX: rr.maxX, minZ: hallZ, maxZ: hallZ + t, minY: 0, maxY: 2.6 }, 'wood');
    this.solid('ref-side', { minX: west ? rr.maxX - t : rr.minX, maxX: west ? rr.maxX : rr.minX + t, minZ: rr.minZ, maxZ: rr.maxZ, minY: 0, maxY: 2.6 }, 'wood');
    this.prop('ref-room', (rr.minX + rr.maxX) / 2, (rr.minZ + rr.maxZ) / 2, w, 2.6, d, 'wood');
    return rr;
  }

  /** Nudges, filters and grades the candidates and returns the finished room. */
  finish(id: string, rr: CamoRoomData['refereeRoom'], hiders: Array<{ x: number; z: number }>, seekersFrom?: Array<{ x: number; z: number }>): CamoRoomData {
    const forbidden: Aabb[] = [
      { minX: rr.minX, maxX: rr.maxX, minZ: rr.minZ, maxZ: rr.maxZ, minY: 0, maxY: WALL_H },
      { minX: rr.door.x - 5, maxX: rr.door.x + 5, minZ: rr.door.z - 5, maxZ: rr.door.z + 5, minY: 0, maxY: WALL_H },
    ];
    const insideSouth = rr.door.z <= rr.minZ + 0.01;
    const seekers =
      seekersFrom ?? [-0.3, 0, 0.3].map((dx, i) => ({ x: round(rr.door.x + dx), z: round(insideSouth ? rr.door.z + 1.3 + (i === 2 ? 0.7 : 0) : rr.door.z - 1.3 - (i === 2 ? 0.7 : 0)) }));
    const draft: CamoRoomData = { id, version: 2, bounds: this.bounds, colliders: this.colliders, hideSpots: [], seats: this.seats, spawns: { hiders, seekers }, refereeRoom: rr, forbidden, props: this.props };
    const grid = buildWalkGrid(draft);
    const reach = reachableFrom(grid, hiders[0]);
    const kept: HideSpot[] = [];
    for (const c of this.candidates) {
      const p = pushOut(draft, c.x, c.z);
      // a candidate that had to be pushed far is not where it was meant to be
      if (Math.hypot(p.x - c.x, p.z - c.z) > 0.55 || !isWalkable(draft, p.x, p.z)) continue;
      if (forbidden.some((f) => insideAabb2d(p.x, p.z, f, 0.1))) continue;
      if (!reach(p)) continue;
      if (kept.some((k) => Math.hypot(k.x - p.x, k.z - p.z) < 0.7)) continue;
      kept.push({ ...c, x: round(p.x), z: round(p.z) });
    }
    // grade by exposure: the share of the compass from which the spot can be seen from further away. The most exposed
    // quarter is «easy», the best tucked-away third is «hard», whatever the room looks like.
    const exposure = new Map<HideSpot, number>();
    for (const s of kept) {
      let open = 0;
      const n = 24;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        if (!lineBlocked(draft, s.x, s.z, s.x + Math.sin(a) * 14, s.z + Math.cos(a) * 14)) open++;
      }
      exposure.set(s, open / n + (s.x * 7 + s.z * 13) * 1e-6); // the tiny term only breaks ties the same way every run
    }
    const ranked = [...kept].sort((a, b) => exposure.get(b)! - exposure.get(a)!);
    ranked.forEach((s, i) => {
      s.difficulty = i < ranked.length * 0.25 ? 1 : i < ranked.length * 0.65 ? 2 : 3;
    });
    draft.hideSpots = kept.map((s, i) => ({ ...s, id: `hs${i + 1}` }));
    return draft;
  }
}
