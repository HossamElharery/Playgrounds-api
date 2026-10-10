export const LAYOUT_ASSETS = ['ps4', 'ps5', 'xbox-series', 'pc', 'vr', 'billiards', 'table-tennis', 'tv', 'monitor', 'couch-single', 'couch-double', 'gaming-seat', 'counter', 'partition', 'door', 'stairs'] as const;
export type LayoutAsset = typeof LAYOUT_ASSETS[number];
export interface LayoutRoom { id: string; name: string; x: number; z: number; width: number; depth: number; occupancy: 'independent' | 'exclusive'; bookableCourtId?: string; }
export interface LayoutFloor { id: string; name: string; width: number; depth: number; elevation: number; rooms: LayoutRoom[]; }
export interface LayoutPlacement { id: string; floorId: string; roomId?: string; unitId?: string; assetKey: LayoutAsset; x: number; z: number; rotation: number; width: number; depth: number; height: number; }
export const LAYOUT_AMBIENCES = ['neon', 'cafe', 'industrial', 'majlis'] as const;
export type LayoutAmbience = typeof LAYOUT_AMBIENCES[number];
/** `ambience` is optional so every document saved before it existed stays valid; absent means `neon`. */
export interface LayoutDocument { schemaVersion: 1; venueId: string; units: 'm'; ambience?: LayoutAmbience; signLogoPhotoId?: string; floors: LayoutFloor[]; placements: LayoutPlacement[]; }

/** Closed schema protects storage/rendering; no arbitrary asset URLs or financial IDs. */
export function validateLayoutDocument(value: unknown, venueId: string, unitIds: ReadonlySet<string>): LayoutDocument {
  const fail = () => { throw new RangeError('Invalid layout document'); };
  const object = (v: unknown, allowed: string[], required: string[]): Record<string, any> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
    const o = v as Record<string, any>;
    if (Object.keys(o).some(k => !allowed.includes(k)) || required.some(k => o[k] === undefined)) return fail();
    return o;
  };
  const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
  const name = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 80;
  const number = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const document = object(value, ['schemaVersion', 'venueId', 'units', 'ambience', 'signLogoPhotoId', 'floors', 'placements'], ['schemaVersion', 'venueId', 'units', 'floors', 'placements']);
  if (document.signLogoPhotoId !== undefined && !id(document.signLogoPhotoId)) fail();
  if (document.ambience !== undefined && !(LAYOUT_AMBIENCES as readonly string[]).includes(document.ambience)) fail();
  if (document.schemaVersion !== 1 || document.venueId !== venueId || document.units !== 'm' || !Array.isArray(document.floors) || document.floors.length < 1 || document.floors.length > 20 || !Array.isArray(document.placements) || document.placements.length > 1000 || Buffer.byteLength(JSON.stringify(value)) > 512000) fail();
  const ids = new Set<string>(); const floorMap = new Map<string, LayoutFloor>(); const roomMap = new Map<string, { floorId: string; room: LayoutRoom }>(); const usedUnits = new Set<string>();
  const unique = (v: unknown) => { if (!id(v) || ids.has(v)) fail(); ids.add(v as string); };
  for (const item of document.floors) {
    const f = object(item, ['id', 'name', 'width', 'depth', 'elevation', 'rooms'], ['id', 'name', 'width', 'depth', 'elevation', 'rooms']);
    unique(f.id);
    if (!name(f.name) || !number(f.width, 2, 200) || !number(f.depth, 2, 200) || !number(f.elevation, -20, 200) || !Array.isArray(f.rooms) || f.rooms.length > 100) fail();
    floorMap.set(f.id, f as LayoutFloor);
    for (const item of f.rooms) {
      const r = object(item, ['id', 'name', 'x', 'z', 'width', 'depth', 'occupancy', 'bookableCourtId'], ['id', 'name', 'x', 'z', 'width', 'depth', 'occupancy']); unique(r.id);
      if (!name(r.name) || !['independent', 'exclusive'].includes(r.occupancy) || !number(r.width, 1, f.width) || !number(r.depth, 1, f.depth) || !number(r.x, 0, f.width - r.width) || !number(r.z, 0, f.depth - r.depth)) fail();
      if (r.occupancy === 'exclusive' && (!unitIds.has(r.bookableCourtId) || [...roomMap.values()].some(x => x.room.bookableCourtId === r.bookableCourtId))) fail();
      if (r.occupancy === 'independent' && r.bookableCourtId !== undefined) fail();
      for (const previous of roomMap.values()) if (previous.floorId === f.id) {
        const p = previous.room;
        if (r.x < p.x + p.width && r.x + r.width > p.x && r.z < p.z + p.depth && r.z + r.depth > p.z) fail();
      }
      roomMap.set(r.id, { floorId: f.id, room: r as LayoutRoom });
    }
  }
  for (const item of document.placements) {
    const p = object(item, ['id', 'floorId', 'roomId', 'unitId', 'assetKey', 'x', 'z', 'rotation', 'width', 'depth', 'height'], ['id', 'floorId', 'assetKey', 'x', 'z', 'rotation', 'width', 'depth', 'height']); unique(p.id);
    const f = floorMap.get(p.floorId);
    if (!f || !LAYOUT_ASSETS.includes(p.assetKey) || !number(p.width, .1, 20) || !number(p.depth, .1, 20) || !number(p.height, .1, 10) || !number(p.rotation, -360, 360)) fail();
    const rad = p.rotation * Math.PI / 180;
    const halfX = (Math.abs(Math.cos(rad)) * p.width + Math.abs(Math.sin(rad)) * p.depth) / 2;
    const halfZ = (Math.abs(Math.sin(rad)) * p.width + Math.abs(Math.cos(rad)) * p.depth) / 2;
    if (!number(p.x, halfX, f!.width - halfX) || !number(p.z, halfZ, f!.depth - halfZ)) fail();
    if (p.unitId !== undefined) {
      if (!id(p.unitId) || !unitIds.has(p.unitId) || usedUnits.has(p.unitId)) fail();
      usedUnits.add(p.unitId);
    }
    if (p.roomId !== undefined) {
      const r = roomMap.get(p.roomId);
      if (!r || r.room.bookableCourtId === p.unitId || r.floorId !== f!.id || p.x - halfX < r.room.x || p.x + halfX > r.room.x + r.room.width || p.z - halfZ < r.room.z || p.z + halfZ > r.room.z + r.room.depth) fail();
    }
  }
  return JSON.parse(JSON.stringify(value)) as LayoutDocument;
}
