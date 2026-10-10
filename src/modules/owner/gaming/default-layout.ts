import { LayoutAsset, LayoutDocument, LayoutFloor, LayoutPlacement, LayoutRoom } from './layout-document';

export interface DefaultLayoutUnit {
  id: string;
  name: string;
  activityKind?: string | null;
  gamingConfig?: unknown;
  tableConfig?: unknown;
}

type Lang = 'ar' | 'en';
const WORDS: Record<Lang, { floor: string; vip: string; vr: string; bar: string }> = {
  ar: { floor: 'الدور الأرضي', vip: 'غرفة VIP', vr: 'كابينة VR', bar: 'البار' },
  en: { floor: 'Ground floor', vip: 'VIP room', vr: 'VR booth', bar: 'Bar' },
};

const MARGIN = 1.5;
/** Footprints in metres: a console station includes its screen, couch and walking space. */
const STATION = { w: 2.6, d: 2.6, stepX: 3.4, stepZ: 3.8 };
const VIP_ROOM = { w: 5.2, d: 4.8, stepX: 5.8, stepZ: 5.4 };
const TABLE = {
  billiards: { w: 2.2, d: 3.4 },
  'table-tennis': { w: 1.8, d: 3 },
};

const cfg = (value: unknown): Record<string, any> => (value && typeof value === 'object' ? (value as Record<string, any>) : {});
const round = (n: number) => Math.round(n * 100) / 100;

function assetOf(unit: DefaultLayoutUnit): LayoutAsset {
  if (unit.activityKind === 'table-game') return cfg(unit.tableConfig).tableType === 'table-tennis' ? 'table-tennis' : 'billiards';
  const console = cfg(unit.gamingConfig).consoleType;
  return (['ps4', 'ps5', 'xbox-series', 'pc', 'vr'].includes(console) ? console : 'ps5') as LayoutAsset;
}

/**
 * A believable first floor plan built from the units a venue already registered: standard consoles
 * in rows, one room per VIP / VR unit, tables in their own zone, a bar and an entrance. The owner
 * only nudges it afterwards. Pure and deterministic, so it is unit-tested and never random.
 */
export function buildDefaultLayout(venueId: string, units: DefaultLayoutUnit[], lang: Lang = 'ar', id: () => string): LayoutDocument {
  const words = WORDS[lang];
  // Newest hardware first (PS5 before PS4), then by the owner's own numbering.
  const rank = (u: DefaultLayoutUnit) => ['ps5', 'xbox-series', 'ps4', 'pc', 'vr', 'billiards', 'table-tennis'].indexOf(assetOf(u));
  const sorted = [...units].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const vip = sorted.filter((u) => u.activityKind === 'gaming-station' && ['vip-big-screen', 'vr-booth'].includes(cfg(u.gamingConfig).roomTier));
  const vipIds = new Set(vip.map((u) => u.id));
  const standard = sorted.filter((u) => u.activityKind === 'gaming-station' && !vipIds.has(u.id));
  const tables = sorted.filter((u) => u.activityKind === 'table-game');
  const other = sorted.filter((u) => !vipIds.has(u.id) && !standard.includes(u) && !tables.includes(u));
  const stations = [...standard, ...other];

  const stationCols = Math.max(1, Math.min(stations.length, 6));
  const vipCols = Math.max(1, Math.min(vip.length, 3));
  const tableCols = Math.max(1, Math.min(tables.length, 4));
  const stationRows = Math.ceil(stations.length / stationCols);
  const vipRows = Math.ceil(vip.length / vipCols);
  const tableRows = Math.ceil(tables.length / tableCols);
  const tableStepX = 3.6;
  const tableStepZ = 4.6;

  const widths = [
    stations.length ? (stationCols - 1) * STATION.stepX + STATION.w : 0,
    vip.length ? (vipCols - 1) * VIP_ROOM.stepX + VIP_ROOM.w : 0,
    tables.length ? (tableCols - 1) * tableStepX + 2.2 : 0,
    8,
  ];
  const width = Math.min(200, round(Math.max(...widths) + MARGIN * 2));

  // Zones stacked from the entrance (high z) towards the back wall (z = 0).
  let cursor = MARGIN;
  const zoneStart = { stations: 0, vip: 0, tables: 0 };
  if (stations.length) { zoneStart.stations = cursor; cursor += (stationRows - 1) * STATION.stepZ + STATION.d + 0.8; }
  if (vip.length) { zoneStart.vip = cursor; cursor += (vipRows - 1) * VIP_ROOM.stepZ + VIP_ROOM.d + 0.8; }
  if (tables.length) { zoneStart.tables = cursor; cursor += (tableRows - 1) * tableStepZ + 3.4 + 0.8; }
  const frontStrip = 2.4; // bar + entrance
  const depth = Math.min(200, round(Math.max(10, cursor + frontStrip)));

  const floorId = id();
  const rooms: LayoutRoom[] = [];
  const placements: LayoutPlacement[] = [];
  const place = (partial: Omit<LayoutPlacement, 'id' | 'floorId' | 'rotation' | 'height'> & { rotation?: number; height?: number }) =>
    placements.push({ id: id(), floorId, rotation: 0, height: 1, ...partial });
  const xOffset = (span: number) => (width - span) / 2;

  stations.forEach((unit, i) => {
    const row = Math.floor(i / stationCols);
    const col = i % stationCols;
    const inRow = Math.min(stationCols, stations.length - row * stationCols);
    const span = (inRow - 1) * STATION.stepX + STATION.w;
    place({
      unitId: unit.id,
      assetKey: assetOf(unit),
      x: round(xOffset(span) + STATION.w / 2 + col * STATION.stepX),
      z: round(zoneStart.stations + STATION.d / 2 + row * STATION.stepZ),
      width: STATION.w,
      depth: STATION.d,
    });
  });

  vip.forEach((unit, i) => {
    const row = Math.floor(i / vipCols);
    const col = i % vipCols;
    const inRow = Math.min(vipCols, vip.length - row * vipCols);
    const span = (inRow - 1) * VIP_ROOM.stepX + VIP_ROOM.w;
    const x = round(xOffset(span) + col * VIP_ROOM.stepX);
    const z = round(zoneStart.vip + row * VIP_ROOM.stepZ);
    const vr = cfg(unit.gamingConfig).roomTier === 'vr-booth';
    const room: LayoutRoom = { id: id(), name: `${vr ? words.vr : words.vip} ${i + 1}`, x, z, width: VIP_ROOM.w, depth: VIP_ROOM.d, occupancy: 'independent' };
    rooms.push(room);
    place({ roomId: room.id, unitId: unit.id, assetKey: assetOf(unit), x: round(x + VIP_ROOM.w / 2), z: round(z + VIP_ROOM.d / 2), width: 3, depth: 3 });
  });

  tables.forEach((unit, i) => {
    const row = Math.floor(i / tableCols);
    const col = i % tableCols;
    const inRow = Math.min(tableCols, tables.length - row * tableCols);
    const asset = assetOf(unit) as 'billiards' | 'table-tennis';
    const size = TABLE[asset];
    const span = (inRow - 1) * tableStepX + 2.2;
    place({
      unitId: unit.id,
      assetKey: asset,
      x: round(xOffset(span) + 1.1 + col * tableStepX),
      z: round(zoneStart.tables + 1.7 + row * tableStepZ),
      width: size.w,
      depth: size.d,
      rotation: asset === 'table-tennis' ? 90 : 0,
    });
  });

  // Bar on the left of the entrance strip, entrance door on the right.
  place({ assetKey: 'counter', x: round(Math.min(width - 1.6, 3.2)), z: round(depth - 1.3), width: 4, depth: 0.9, height: 1.1 });
  place({ assetKey: 'door', x: round(width - 2), z: round(depth - 0.2), width: 1.4, depth: 0.2, height: 2.1 });

  const floor: LayoutFloor = { id: floorId, name: words.floor, width, depth, elevation: 0, rooms };
  return { schemaVersion: 1, venueId, units: 'm', floors: [floor], placements };
}
