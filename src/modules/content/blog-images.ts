import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const sharp: typeof import('sharp').default = require('sharp');

const UPLOAD_SRC =
  /^(?:https?:\/\/[^/]+)?\/uploads\/([a-z0-9-]+\/[a-z0-9-]+\.(?:png|jpe?g|webp|avif))(?:[?#].*)?$/i;
const sizeCache = new Map<string, { width: number; height: number } | null>();

async function imageSize(
  uploadsRoot: string,
  key: string,
): Promise<{ width: number; height: number } | null> {
  if (sizeCache.has(key)) return sizeCache.get(key) ?? null;
  let size: { width: number; height: number } | null = null;
  try {
    const meta = await sharp(await readFile(join(uploadsRoot, key)), {
      limitInputPixels: 80_000_000,
    }).metadata();
    if (meta.width && meta.height)
      size = { width: meta.width, height: meta.height };
  } catch {
    size = null;
  }
  sizeCache.set(key, size);
  return size;
}

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export async function enrichArticleImages(
  html: string,
  fallbackAlt: string,
  uploadsRoot: string,
): Promise<string> {
  const tags = [...new Set(html.match(/<img\b[^>]*>/gi) ?? [])];
  if (!tags.length) return html;
  const replacements = new Map<string, string>();
  for (const tag of tags) {
    const has = (attr: string) => new RegExp(`\\s${attr}\\s*=`, 'i').test(tag);
    const extras: string[] = [];
    const src = /\ssrc\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    const key = src ? UPLOAD_SRC.exec(src)?.[1] : undefined;
    if (key && !(has('width') && has('height'))) {
      const size = await imageSize(uploadsRoot, key);
      if (size) extras.push(`width="${size.width}"`, `height="${size.height}"`);
    }
    if (!has('alt') && fallbackAlt)
      extras.push(`alt="${escapeAttr(fallbackAlt)}"`);
    if (!has('loading')) extras.push('loading="lazy"');
    if (!has('decoding')) extras.push('decoding="async"');
    if (extras.length)
      replacements.set(
        tag,
        tag.replace(/^<img\b/i, `<img ${extras.join(' ')}`),
      );
  }
  let out = html;
  for (const [from, to] of replacements) out = out.split(from).join(to);
  return out;
}
