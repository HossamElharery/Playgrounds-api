import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  IMAGE_VARIANT_WIDTHS,
  imageVariantKey,
  imageVariantWidths,
  warmImageVariants,
} from '../modules/storage/image-variants';

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function main() {
  if (process.env.STORAGE_PROVIDER === 's3')
    throw new Error('This script only handles local uploads.');
  const apply = process.argv.includes('--apply');
  const only = process.argv
    .find((arg) => arg.startsWith('--only='))
    ?.slice('--only='.length)
    .split(',')
    .filter(Boolean);
  const root = join(process.cwd(), 'uploads');
  const prefixes = Object.keys(IMAGE_VARIANT_WIDTHS).filter(
    (prefix) => !only || only.includes(prefix),
  );
  let images = 0;
  let written = 0;
  let failed = 0;
  for (const prefix of prefixes) {
    let names: string[];
    try {
      names = await readdir(join(root, prefix));
    } catch {
      console.log(`${prefix}: no folder, skipped`);
      continue;
    }
    let folderImages = 0;
    let folderMissing = 0;
    for (const name of names) {
      const key = `${prefix}/${name}`;
      const widths = imageVariantWidths(key);
      if (!widths.length) continue;
      folderImages++;
      const missing: number[] = [];
      for (const width of widths) {
        if (!(await exists(join(root, imageVariantKey(key, width)!))))
          missing.push(width);
      }
      if (!missing.length) continue;
      folderMissing += missing.length;
      if (!apply) continue;
      try {
        await warmImageVariants(root, key);
      } catch (error) {
        failed++;
        console.warn(
          `Skipped ${key}: ${error instanceof Error ? error.message : 'unreadable image'}`,
        );
      }
    }
    images += folderImages;
    written += folderMissing;
    console.log(
      `${prefix}: ${folderImages} images, ${apply ? 'wrote' : 'would write'} ${folderMissing} variants`,
    );
  }
  console.log(
    `Total: ${images} images, ${apply ? 'wrote' : 'would write'} ${written} variants` +
      (failed ? `, ${failed} images skipped (unreadable or too large)` : '') +
      '. Originals retained.',
  );
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Variant backfill failed',
  );
  process.exitCode = 1;
});
