const sharp: typeof import('sharp').default = require('sharp');
import { OG_ROOM_JPEG } from './camo-og-assets';

export const OG_W = 1200;
export const OG_H = 630;

const FALLBACK_ROOM = 'locker_room';
const bases = new Map<string, Buffer>();

const baseFor = (roomId: string): Buffer => {
  const id = OG_ROOM_JPEG[roomId] ? roomId : FALLBACK_ROOM;
  let b = bases.get(id);
  if (!b) {
    b = Buffer.from(OG_ROOM_JPEG[id], 'base64');
    bases.set(id, b);
  }
  return b;
};

/**
 * The link-preview card of a challenge (1200x630 JPEG): an empty shot of the room under a magnifier, and a row of dots
 * for the tries so far (lime = found it). There is no text on it (no font is needed on the server; the title and the
 * description in the page's meta carry the words) and, by construction, nothing of the hider: the base picture is a
 * render of the room with nobody in it and the only inputs are the room id and two counters.
 */
export async function renderChallengeOg(roomId: string, attempts: number, found: number): Promise<Buffer> {
  const dots = Math.min(12, Math.max(0, attempts));
  const hit = Math.min(dots, Math.max(0, found));
  const dotSvg = Array.from({ length: dots }, (_, i) => {
    const x = OG_W / 2 - ((dots - 1) * 44) / 2 + i * 44;
    return `<circle cx="${x}" cy="548" r="14" fill="${i < hit ? '#c6ff3d' : '#ffffff'}" fill-opacity="${i < hit ? 1 : 0.35}"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05070d" stop-opacity="0.15"/><stop offset="1" stop-color="#05070d" stop-opacity="0.8"/></linearGradient></defs>
  <rect width="${OG_W}" height="${OG_H}" fill="url(#g)"/>
  <circle cx="560" cy="270" r="118" fill="#000" fill-opacity="0.18" stroke="#c6ff3d" stroke-width="22"/>
  <line x1="646" y1="356" x2="760" y2="470" stroke="#c6ff3d" stroke-width="30" stroke-linecap="round"/>
  <path d="M520 235 q0 -50 48 -50 q48 0 48 44 q0 28 -34 44 q-14 8 -14 26" fill="none" stroke="#c6ff3d" stroke-width="18" stroke-linecap="round"/>
  <circle cx="568" cy="334" r="11" fill="#c6ff3d"/>
  ${dotSvg}
</svg>`;
  return sharp(baseFor(roomId)).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
}
