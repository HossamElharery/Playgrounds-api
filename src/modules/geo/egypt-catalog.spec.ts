import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EGYPT_GEO } from '../../../prisma/data/egypt-geo';
const root=join(__dirname,'../../../prisma');
const areas=JSON.parse(readFileSync(join(root,'data/egypt-cod-areas.json'),'utf8'));
describe('Additive Egyptian area catalog',()=>{
 it('covers all 27 existing governorates and both administrative levels',()=>{
  expect(new Set(areas.map(a=>a.governorateId))).toEqual(new Set(EGYPT_GEO.map(g=>g.id)));
  expect(areas.filter(a=>a.level===2)).toHaveLength(365);
  expect(areas.filter(a=>a.level===3)).toHaveLength(5716);
 });
 it('has stable unique identifiers, parent-disambiguated names and valid centers',()=>{
  expect(new Set(areas.map(a=>a.id)).size).toBe(areas.length);
  expect(new Set(areas.map(a=>a.governorateId+':'+a.slug)).size).toBe(areas.length);
  for(const a of areas){
   expect(a.nameAr.trim().length).toBeGreaterThan(0);
   expect(a.nameEn.trim().length).toBeGreaterThan(0);
   expect(a.lat).toBeGreaterThan(21);expect(a.lat).toBeLessThan(33);
   expect(a.lng).toBeGreaterThan(24);expect(a.lng).toBeLessThan(37);
   if(a.level===3)expect(a.nameAr).toContain(' — ');
  }
 });
 it('installs exactly the seed catalog without changing preexisting areas',()=>{
  const sql=readFileSync(join(root,'migrations/20261010090000_egypt_full_area_catalog/migration.sql'),'utf8');
  expect(sql).toContain('ON CONFLICT DO NOTHING');
  expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|DROP)\b/i);
  for(const a of areas)expect(sql).toContain("'"+a.id+"'");
 });
});
