import { readFileSync } from 'fs';
import { join } from 'path';
import { EGYPT_GEO } from '../prisma/data/egypt-geo';

const migration = (name: string) => readFileSync(join(__dirname, '..', 'prisma', 'migrations', name, 'migration.sql'), 'utf8');

describe('Egypt geography (what an owner picks when registering a venue)', () => {
  it('offers every governorate, including the big three and Beni Suef', () => {
    expect(EGYPT_GEO).toHaveLength(27);
    const slugs = EGYPT_GEO.map((g) => g.slug);
    for (const must of ['cairo', 'giza', 'alexandria', 'beni-suef', 'dakahlia', 'red-sea', 'aswan', 'matrouh']) expect(slugs).toContain(must);
  });

  it('every governorate has at least one district (the sign-up form requires both)', () => {
    for (const g of EGYPT_GEO) expect(g.districts.length).toBeGreaterThan(0);
  });

  it('ids and slugs never collide, and every place has an Arabic name and real Egyptian coordinates', () => {
    const govIds = new Set<string>();
    const districtIds = new Set<string>();
    for (const g of EGYPT_GEO) {
      expect(govIds.has(g.id)).toBe(false);
      govIds.add(g.id);
      expect(g.nameAr).toMatch(/[\u0600-\u06FF]/);
      const slugs = new Set<string>();
      for (const d of g.districts) {
        expect(districtIds.has(d.id)).toBe(false);
        districtIds.add(d.id);
        expect(slugs.has(d.slug)).toBe(false);
        slugs.add(d.slug);
        expect(d.nameAr).toMatch(/[\u0600-\u06FF]|\d/);
        expect(d.lat).toBeGreaterThan(21.5);
        expect(d.lat).toBeLessThan(32);
        expect(d.lng).toBeGreaterThan(24.5);
        expect(d.lng).toBeLessThan(37);
      }
    }
  });

  it('Beni Suef has its own city and neighbouring centres', () => {
    const bs = EGYPT_GEO.find((g) => g.slug === 'beni-suef')!;
    expect(bs.nameAr).toBe('بني سويف');
    expect(bs.districts.map((d) => d.slug)).toEqual(expect.arrayContaining(['beni-suef-city', 'el-wasta', 'nasser']));
  });

  it('the production migration installs exactly the same places as local development', () => {
    const sql = migration('20261005110000_egypt_governorates');
    const govIds = [...sql.matchAll(/^ {2}\('(gov-[^']+)'/gm)].map((m) => m[1]).sort();
    const districtIds = [...sql.matchAll(/^ {2}\('(dist-[^']+)'/gm)].map((m) => m[1]).sort();
    expect(govIds).toEqual(EGYPT_GEO.map((g) => g.id).sort());
    expect(districtIds).toEqual(EGYPT_GEO.flatMap((g) => g.districts.map((d) => d.id)).sort());
  });

  it('the migration is safe to run on production: it never overwrites or removes what is there', () => {
    const sql = migration('20261005110000_egypt_governorates');
    expect(sql).not.toMatch(/\b(DELETE|DROP|TRUNCATE|UPDATE)\b/i);
    expect(sql.match(/ON CONFLICT DO NOTHING/g)).toHaveLength(2);
  });
});

describe('overnight price windows', () => {
  it('the repair migration splits a window that crossed midnight and never touches a valid one', () => {
    const sql = migration('20261005100000_fix_overnight_pricing_rules');
    expect(sql).toContain('"endTime" < "startTime"');
    expect(sql).toContain("'00:00'");
    expect(sql).toContain('SET "endTime" = \'24:00\'');
    // Only rows that never matched anything are selected.
    expect(sql.match(/WHERE "endTime" <=? "startTime"/g)?.length).toBeGreaterThanOrEqual(1);
  });

  it('the demo seed no longer ships a window that ends before it starts', () => {
    const seed = readFileSync(join(__dirname, '..', 'prisma', 'seed.ts'), 'utf8');
    const windows = [...seed.matchAll(/startTime: '(\d\d:\d\d)', endTime: '(\d\d:\d\d)'/g)].map((m) => [m[1], m[2]]);
    expect(windows.length).toBeGreaterThan(5);
    for (const [from, to] of windows) expect(to > from).toBe(true);
  });
});
