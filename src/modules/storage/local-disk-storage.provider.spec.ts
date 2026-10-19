const sharp: typeof import('sharp').default = require('sharp');
import { ConfigService } from '@nestjs/config';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDiskStorageProvider } from './local-disk-storage.provider';

describe('LocalDiskStorageProvider image variants', () => {
  let cwd: string;
  let previous: string;

  beforeEach(async () => {
    previous = process.cwd();
    cwd = await mkdtemp(join(tmpdir(), 'storage-'));
    process.chdir(cwd);
  });

  afterEach(async () => {
    process.chdir(previous);
    await rm(cwd, { recursive: true, force: true });
  });

  const exists = (file: string) =>
    stat(file).then(
      () => true,
      () => false,
    );

  async function waitFor(file: string): Promise<void> {
    for (let i = 0; i < 100 && !(await exists(file)); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('warms variants after an upload and deletes them with the original', async () => {
    const provider = new LocalDiskStorageProvider(new ConfigService());
    const photo = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: '#0e7a4e' },
    })
      .jpeg()
      .toBuffer();
    const { key, url } = await provider.uploadBuffer(
      photo,
      'court.JPG',
      'image/jpeg',
      'venues',
    );
    expect(url).toBe(`/uploads/${key}`);
    const name = key.slice('venues/'.length, -'.JPG'.length);
    const variants = [320, 480, 640, 960, 1280, 1920].map((w) =>
      join(cwd, 'uploads', `venues/w${w}/${name}.webp`),
    );
    await waitFor(variants[variants.length - 1]);
    for (const file of variants) expect(await exists(file)).toBe(true);

    await provider.deleteObject(key);
    expect(await exists(join(cwd, 'uploads', key))).toBe(false);
    for (const file of variants) expect(await exists(file)).toBe(false);
  });

  it('leaves documents alone', async () => {
    const provider = new LocalDiskStorageProvider(new ConfigService());
    await provider.uploadBuffer(
      Buffer.from('%PDF-1.4'),
      'license.pdf',
      'application/pdf',
      'partner-docs',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readdir(join(cwd, 'uploads', 'partner-docs'))).toHaveLength(1);
  });
});
