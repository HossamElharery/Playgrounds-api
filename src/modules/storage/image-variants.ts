import type { NextFunction, Request, Response } from 'express';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const sharp: typeof import('sharp').default = require('sharp');

// 320 and 480 serve phone thumbnails (cards about 150-200 CSS px wide), which otherwise download the 640w file.
const PHOTO_WIDTHS = [320, 480, 640, 960, 1280, 1920] as const;
const AVATAR_WIDTHS = [128, 256, 512] as const;

export const IMAGE_VARIANT_WIDTHS: Readonly<Record<string, readonly number[]>> =
  {
    // Blog covers, inline article images and partner-application photos.
    'partner-photos': PHOTO_WIDTHS,
    venues: PHOTO_WIDTHS,
    posts: PHOTO_WIDTHS,
    chat: PHOTO_WIDTHS,
    avatars: AVATAR_WIDTHS,
  };
const SOURCE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'avif'].flatMap(
  (ext) => [ext, ext.toUpperCase()],
);
const SOURCE_KEY = /^([a-z0-9-]+)\/([a-z0-9-]+)\.(png|jpe?g|webp|avif)$/i;
const VARIANT_PATH = /^\/([a-z0-9-]+)\/w(\d+)\/([a-z0-9-]+)\.webp$/i;

export interface ParsedVariant {
  prefix: string;
  width: number;
  name: string;
  key: string;
}

function widthsFor(prefix: string): readonly number[] {
  return Object.hasOwn(IMAGE_VARIANT_WIDTHS, prefix)
    ? IMAGE_VARIANT_WIDTHS[prefix]
    : [];
}

export function imageVariantWidths(sourceKey: string): readonly number[] {
  const match = SOURCE_KEY.exec(sourceKey);
  return match ? widthsFor(match[1]) : [];
}

export function imageVariantKey(
  sourceKey: string,
  width: number,
): string | undefined {
  const match = SOURCE_KEY.exec(sourceKey);
  if (!match || !widthsFor(match[1]).includes(width)) return undefined;
  return `${match[1]}/w${width}/${match[2]}.webp`;
}

export function parseVariantPath(
  requestPath: string,
): ParsedVariant | undefined {
  const match = VARIANT_PATH.exec(requestPath);
  if (!match) return undefined;
  const [, prefix, rawWidth, name] = match;
  const width = Number(rawWidth);
  if (!widthsFor(prefix).includes(width)) return undefined;
  return { prefix, width, name, key: `${prefix}/w${width}/${name}.webp` };
}

export async function createImageVariant(
  buffer: Buffer,
  width: number,
): Promise<Buffer> {
  return sharp(buffer, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: width <= 640 ? 72 : 76, effort: 4 })
    .toBuffer();
}

async function readOriginal(
  root: string,
  prefix: string,
  name: string,
): Promise<Buffer | undefined> {
  for (const ext of SOURCE_EXTENSIONS) {
    try {
      return await readFile(join(root, prefix, `${name}.${ext}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

async function writeAtomically(target: string, data: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, data);
  await rename(temp, target);
}

const inFlight = new Map<string, Promise<Buffer | undefined>>();

const MAX_PARALLEL_RESIZES = 2;
let activeResizes = 0;
const resizeQueue: (() => void)[] = [];

async function withResizeSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeResizes >= MAX_PARALLEL_RESIZES)
    await new Promise<void>((resolve) => resizeQueue.push(resolve));
  activeResizes++;
  try {
    return await work();
  } finally {
    activeResizes--;
    resizeQueue.shift()?.();
  }
}

export function ensureImageVariant(
  root: string,
  variant: ParsedVariant,
): Promise<Buffer | undefined> {
  const pending = inFlight.get(variant.key);
  if (pending) return pending;
  const job = (async () => {
    const target = join(root, variant.key);
    try {
      return await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const original = await readOriginal(root, variant.prefix, variant.name);
    if (!original) return undefined;
    const output = await withResizeSlot(() =>
      createImageVariant(original, variant.width),
    );
    await writeAtomically(target, output);
    return output;
  })().finally(() => inFlight.delete(variant.key));
  inFlight.set(variant.key, job);
  return job;
}

export async function warmImageVariants(
  root: string,
  sourceKey: string,
): Promise<void> {
  for (const width of imageVariantWidths(sourceKey)) {
    const variant = parseVariantPath(`/${imageVariantKey(sourceKey, width)}`);
    if (!variant) return;
    await ensureImageVariant(root, variant);
  }
}

export function imageVariantMiddleware(root: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const variant = parseVariantPath(req.path);
    if (!variant) return next();
    ensureImageVariant(root, variant).then(
      (data) => {
        if (!data) return next();
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Content-Length', data.length);
        if (req.method === 'HEAD') res.end();
        else res.end(data);
      },
      () => next(),
    );
  };
}
