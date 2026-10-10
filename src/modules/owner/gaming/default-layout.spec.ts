import { buildDefaultLayout, DefaultLayoutUnit } from './default-layout';
import { validateLayoutDocument } from './layout-document';

let n = 0;
const id = () => `id-${++n}`;
const ps = (i: number, tier = 'standard', kind = 'ps5'): DefaultLayoutUnit => ({ id: `u${i}-${tier}`, name: `Station ${i}`, activityKind: 'gaming-station', gamingConfig: { consoleType: kind, roomTier: tier, seats: 4 } });
const table = (i: number, type = 'american-8-ball'): DefaultLayoutUnit => ({ id: `t${i}`, name: `Table ${i}`, activityKind: 'table-game', tableConfig: { tableType: type, rentalAvailable: true } });

describe('buildDefaultLayout', () => {
  const check = (units: DefaultLayoutUnit[], lang: 'ar' | 'en' = 'en') => {
    const doc = buildDefaultLayout('venue-1', units, lang, id);
    // The server's own validator is the contract: every generated plan must publish as-is.
    expect(() => validateLayoutDocument(doc, 'venue-1', new Set(units.map((u) => u.id)))).not.toThrow();
    return doc;
  };

  it('places every unit exactly once, for 1 / 8 / 40 / 100 stations', () => {
    for (const count of [1, 8, 40, 100]) {
      const units = Array.from({ length: count }, (_, i) => ps(i + 1));
      const doc = check(units);
      expect(doc.placements.filter((p) => p.unitId).map((p) => p.unitId).sort()).toEqual(units.map((u) => u.id).sort());
    }
  });

  it('puts VIP and VR units in their own rooms and tables in a table zone', () => {
    const units = [ps(1), ps(2), ps(3, 'vip-big-screen'), ps(4, 'vr-booth', 'vr'), table(1), table(2, 'table-tennis')];
    const doc = check(units, 'ar');
    expect(doc.floors[0].name).toBe('الدور الأرضي');
    expect(doc.floors[0].rooms.map((r) => r.name)).toEqual(['غرفة VIP 1', 'كابينة VR 2']);
    expect(doc.placements.find((p) => p.unitId === 't2')?.assetKey).toBe('table-tennis');
    expect(doc.placements.filter((p) => p.assetKey === 'counter' || p.assetKey === 'door').length).toBe(2);
  });

  it('does not overlap stations, rooms or tables', () => {
    const units = [...Array.from({ length: 12 }, (_, i) => ps(i + 1)), ps(20, 'vip-big-screen'), ps(21, 'vip-big-screen'), table(1), table(2), table(3)];
    const doc = check(units);
    const boxes = doc.placements.map((p) => ({ id: p.id, x: p.x, z: p.z, w: p.rotation === 90 ? p.depth : p.width, d: p.rotation === 90 ? p.width : p.depth }));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const overlap = Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 0.01 && Math.abs(a.z - b.z) < (a.d + b.d) / 2 - 0.01;
        expect({ pair: `${a.id} vs ${b.id}`, overlap }).toEqual({ pair: `${a.id} vs ${b.id}`, overlap: false });
      }
  });
});
