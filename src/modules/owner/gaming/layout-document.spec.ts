import { validateLayoutDocument } from './layout-document';
const layout = () => ({ schemaVersion: 1, venueId: 'venue-1', units: 'm', floors: [{ id: 'ground', name: 'الأرضي', width: 20, depth: 12, elevation: 0, rooms: [] }], placements: [{ id: 'p1', floorId: 'ground', unitId: 'unit-1', assetKey: 'ps5', x: 2, z: 2, rotation: 0, width: 1, depth: 1, height: 1 }] });
const validate = (value: unknown) => validateLayoutDocument(value, 'venue-1', new Set(['unit-1']));
describe('layout server invariants B01/B03/B04', () => {
  it('accepts three independent floors and preserves business identity', () => {
    const d = layout(); d.floors.push({ ...d.floors[0], id: 'first', elevation: 3 }, { ...d.floors[0], id: 'second', elevation: 6 });
    expect(validate(d).placements[0].unitId).toBe('unit-1');
    expect(validate(d).floors).toHaveLength(3);
  });
  it('rejects foreign venues and unit IDs', () => {
    const d = layout(); expect(() => validate({ ...d, venueId: 'other' })).toThrow();
    d.placements[0].unitId = 'other'; expect(() => validate(d)).toThrow();
  });
  it('rejects duplicate floor and placement/unit identities', () => {
    const d = layout(); d.floors.push(d.floors[0]); expect(() => validate(d)).toThrow();
    const p = layout(); p.placements.push({ ...p.placements[0], id: 'p2' }); expect(() => validate(p)).toThrow();
  });
  it.each([NaN, Infinity, -1, 201])('rejects invalid floor width %s', width => { const d = layout(); d.floors[0].width = width; expect(() => validate(d)).toThrow(); });
  it('rejects out of bounds and rotated bounds', () => {
    const d = layout(); d.placements[0].x = .6; d.placements[0].width = 2; expect(() => validate(d)).toThrow();
    d.placements[0].width = 1; d.placements[0].rotation = 45; expect(() => validate(d)).toThrow();
  });
  it('rejects arbitrary URLs, unknown fields and exclusive rooms until shared occupancy exists', () => {
    const d = layout(); expect(() => validate({ ...d, url: 'https://example.com/asset' })).toThrow();
    d.placements[0].assetKey = 'https://example.com'; expect(() => validate(d)).toThrow();
    const r = layout(); (r.floors[0].rooms as any[]).push({ id: 'r1', name: 'VIP', x: 0, z: 0, width: 5, depth: 5, occupancy: 'exclusive' }); expect(() => validate(r)).toThrow();
  });
  it('keeps documents without an ambience valid and accepts only the known ones', () => {
    expect(validate(layout()).ambience).toBeUndefined();
    for (const ambience of ['neon', 'cafe', 'industrial', 'majlis']) expect(validate({ ...layout(), ambience }).ambience).toBe(ambience);
    for (const ambience of ['', 'Neon', 'https://example.com/sky.hdr', null, 3, {}]) expect(() => validate({ ...layout(), ambience })).toThrow();
  });
  it('accepts a sign logo photo id and refuses anything that is not a plain id', () => {
    expect(validate({ ...layout(), signLogoPhotoId: '3f2a-photo_1' }).signLogoPhotoId).toBe('3f2a-photo_1');
    for (const bad of ['', 'https://x.io/logo.png', '../../etc/passwd', 'a'.repeat(81), null, 5, {}]) expect(() => validate({ ...layout(), signLogoPhotoId: bad })).toThrow();
  });
});
