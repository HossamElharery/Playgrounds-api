/**
 * Draws a top-down map (SVG) of a camo room: colliders by material, hide spots by difficulty, spawns, the referees' room.
 * Usage: npx ts-node --transpile-only tools/camo-room-map.ts <roomId> <out.svg>
 */
import { writeFileSync } from 'node:fs';
import { generateLockerRoom } from '../src/modules/camo/camo-room-locker';
import { M2_ROOMS } from '../src/modules/camo/camo-rooms-m2';
import type { CamoRoomData } from '../src/modules/camo/camo-room';

const id = process.argv[2] ?? 'locker_room';
const out = process.argv[3] ?? `/tmp/${id}.svg`;
const room: CamoRoomData = [generateLockerRoom, ...M2_ROOMS].map((g) => g()).find((r) => r.id === id)!;
const S = 28;
const b = room.bounds;
const W = (b.maxX - b.minX) * S;
const H = (b.maxZ - b.minZ) * S;
const X = (x: number) => (x - b.minX) * S;
const Z = (z: number) => (z - b.minZ) * S;
const fill: Record<string, string> = { metal: '#3d6a96', wood: '#8a5a33', concrete: '#9a968c', cloth: '#6a8f6a', tile: '#4aa3ad', grass: '#3a7a3a' };
const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 40}" viewBox="0 0 ${W} ${H + 40}"><rect width="${W}" height="${H}" fill="#1b1f24"/>`];
for (let x = Math.ceil(b.minX); x <= b.maxX; x += 2) parts.push(`<line x1="${X(x)}" y1="0" x2="${X(x)}" y2="${H}" stroke="#2a3038" stroke-width="1"/>`);
for (let z = Math.ceil(b.minZ); z <= b.maxZ; z += 2) parts.push(`<line x1="0" y1="${Z(z)}" x2="${W}" y2="${Z(z)}" stroke="#2a3038" stroke-width="1"/>`);
for (const c of room.colliders) {
  if (c.id.startsWith('wall-')) continue;
  parts.push(`<rect x="${X(c.minX)}" y="${Z(c.minZ)}" width="${(c.maxX - c.minX) * S}" height="${(c.maxZ - c.minZ) * S}" fill="${fill[c.material]}" opacity="${c.maxY < 1 ? 0.55 : 0.95}"/>`);
}
const rr = room.refereeRoom;
parts.push(`<rect x="${X(rr.minX)}" y="${Z(rr.minZ)}" width="${(rr.maxX - rr.minX) * S}" height="${(rr.maxZ - rr.minZ) * S}" fill="none" stroke="#ffd23f" stroke-width="2" stroke-dasharray="6 4"/>`);
const col = ['#fff', '#5dff7a', '#ffd23f', '#ff5d5d'];
for (const s of room.hideSpots) {
  parts.push(`<circle cx="${X(s.x)}" cy="${Z(s.z)}" r="5" fill="${col[s.difficulty]}" stroke="#000" stroke-width="1"/><line x1="${X(s.x)}" y1="${Z(s.z)}" x2="${X(s.x) + s.nx * 11}" y2="${Z(s.z) + s.nz * 11}" stroke="${col[s.difficulty]}" stroke-width="2"/>`);
}
for (const p of room.spawns.hiders) parts.push(`<rect x="${X(p.x) - 4}" y="${Z(p.z) - 4}" width="8" height="8" fill="#0af"/>`);
for (const p of room.spawns.seekers) parts.push(`<rect x="${X(p.x) - 4}" y="${Z(p.z) - 4}" width="8" height="8" fill="#f0f"/>`);
const dist = [1, 2, 3].map((d) => room.hideSpots.filter((s) => s.difficulty === d).length);
parts.push(`<text x="8" y="${H + 24}" fill="#fff" font-family="monospace" font-size="16">${id}: ${room.hideSpots.length} spots (easy ${dist[0]} / medium ${dist[1]} / hard ${dist[2]}), ${room.colliders.length} colliders, ${room.props.length} props</text></svg>`);
writeFileSync(out, parts.join(''));
console.log(id, room.hideSpots.length, 'spots', dist, 'colliders', room.colliders.length, 'props', room.props.length);
