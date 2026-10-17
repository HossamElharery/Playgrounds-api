// The backend uses legacy CommonJS resolution; sharp's runtime export is callable.
const sharp: typeof import('sharp').default = require('sharp');
import type { Request, Response } from 'express';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureImageVariant,
  imageVariantKey,
  imageVariantMiddleware,
  imageVariantWidths,
  parseVariantPath,
  warmImageVariants,
} from './image-variants';

const ID = '28df4402-2192-4c55-9784-5516a568084a';

describe('image variants', () => {
  let root: string;
  let original: Buffer;

  beforeAll(async () => {
    original = await sharp({
      create: { width: 3168, height: 1344, channels: 3, background: '#177544' },
    })
      .png()
      .toBuffer();
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'variants-'));
    await mkdir(join(root, 'partner-photos'), { recursive: true });
    await writeFile(join(root, 'partner-photos', `${ID}.png`), original);
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  it('maps an original key to its variant key', () => {
    expect(imageVariantKey(`partner-photos/${ID}.png`, 640)).toBe(
      `partner-photos/w640/${ID}.webp`,
    );
    expect(imageVariantKey(`venues/${ID}.JPG`, 1920)).toBe(
      `venues/w1920/${ID}.webp`,
    );
    expect(imageVariantKey(`avatars/${ID}.jpg`, 256)).toBe(
      `avatars/w256/${ID}.webp`,
    );
    expect(imageVariantKey(`avatars/${ID}.jpg`, 640)).toBeUndefined();
    expect(imageVariantKey(`partner-docs/${ID}.pdf`, 640)).toBeUndefined();
    expect(imageVariantKey(`posts/${ID}.mp4`, 640)).toBeUndefined();
    expect(
      imageVariantKey(`posts/thumbnails/${ID}-192.webp`, 640),
    ).toBeUndefined();
    expect(imageVariantWidths(`avatars/${ID}.png`)).toEqual([128, 256, 512]);
    expect(imageVariantWidths(`chat/${ID}.webp`)).toEqual([640, 960, 1280, 1920]);
    expect(imageVariantWidths(`misc/${ID}.png`)).toEqual([]);
  });

  it('only accepts known widths, folders and plain file names', () => {
    expect(parseVariantPath(`/partner-photos/w1280/${ID}.webp`)).toMatchObject({
      width: 1280,
      key: `partner-photos/w1280/${ID}.webp`,
    });
    for (const bad of [
      `/partner-photos/w700/${ID}.webp`,
      `/partner-docs/w640/${ID}.webp`,
      `/avatars/w640/${ID}.webp`,
      `/constructor/w640/${ID}.webp`,
      `/partner-photos/w640/../${ID}.webp`,
      `/partner-photos/w640/${ID}.png`,
      `/partner-photos/${ID}.png`,
    ]) {
      expect(parseVariantPath(bad)).toBeUndefined();
    }
  });

  it('cuts a WebP at the requested width and caches it on disk', async () => {
    const variant = parseVariantPath(`/partner-photos/w640/${ID}.webp`)!;
    const data = await ensureImageVariant(root, variant);
    expect(await sharp(data).metadata()).toMatchObject({
      format: 'webp',
      width: 640,
      height: 272,
    });
    expect(data!.length).toBeLessThan(original.length);
    const cached = await readFile(join(root, variant.key));
    expect(cached.equals(data!)).toBe(true);
    expect(
      (await readFile(join(root, 'partner-photos', `${ID}.png`))).equals(
        original,
      ),
    ).toBe(true);
  });

  it('never enlarges a small original', async () => {
    const small = await sharp({
      create: { width: 500, height: 300, channels: 3, background: '#fff' },
    })
      .jpeg()
      .toBuffer();
    await writeFile(join(root, 'partner-photos', 'small.jpg'), small);
    const data = await ensureImageVariant(
      root,
      parseVariantPath('/partner-photos/w1920/small.webp')!,
    );
    expect(await sharp(data).metadata()).toMatchObject({ width: 500 });
  });

  it('resolves undefined when the original is missing', async () => {
    await expect(
      ensureImageVariant(
        root,
        parseVariantPath('/partner-photos/w640/missing.webp')!,
      ),
    ).resolves.toBeUndefined();
  });

  it('warms every width for an upload and ignores documents', async () => {
    await warmImageVariants(root, `partner-photos/${ID}.png`);
    for (const width of [640, 960, 1280, 1920]) {
      expect(
        (await stat(join(root, `partner-photos/w${width}/${ID}.webp`))).size,
      ).toBeGreaterThan(0);
    }
    await expect(
      warmImageVariants(root, `partner-docs/${ID}.pdf`),
    ).resolves.toBeUndefined();
  });

  it('middleware serves a generated variant and falls through otherwise', async () => {
    const middleware = imageVariantMiddleware(root);
    const run = (path: string) =>
      new Promise<{
        next: boolean;
        headers: Record<string, unknown>;
        body?: Buffer;
      }>((resolve) => {
        const headers: Record<string, unknown> = {};
        const res = {
          setHeader: (k: string, v: unknown) => (headers[k] = v),
          end: (body?: Buffer) => resolve({ next: false, headers, body }),
        } as unknown as Response;
        middleware({ method: 'GET', path } as Request, res, () =>
          resolve({ next: true, headers }),
        );
      });

    const hit = await run(`/partner-photos/w1280/${ID}.webp`);
    expect(hit.next).toBe(false);
    expect(hit.headers['Content-Type']).toBe('image/webp');
    expect(hit.headers['Cache-Control']).toContain('immutable');
    expect((await sharp(hit.body).metadata()).width).toBe(1280);

    expect((await run('/partner-photos/w1280/missing.webp')).next).toBe(true);
    expect((await run(`/partner-photos/w999/${ID}.webp`)).next).toBe(true);
    expect((await run(`/partner-photos/${ID}.png`)).next).toBe(true);
  });
  it('finds an original saved with an upper-case extension', async () => {
    await mkdir(join(root, 'venues'), { recursive: true });
    await writeFile(join(root, 'venues', `${ID}.JPG`), original);
    const data = await ensureImageVariant(
      root,
      parseVariantPath(`/venues/w640/${ID}.webp`)!,
    );
    expect((await sharp(data).metadata()).width).toBe(640);
  });

  it('cuts avatars at small widths', async () => {
    await mkdir(join(root, 'avatars'), { recursive: true });
    await writeFile(join(root, 'avatars', `${ID}.png`), original);
    await warmImageVariants(root, `avatars/${ID}.png`);
    for (const width of [128, 256, 512]) {
      const meta = await sharp(
        await readFile(join(root, `avatars/w${width}/${ID}.webp`)),
      ).metadata();
      expect(meta.width).toBe(width);
    }
  });
});
