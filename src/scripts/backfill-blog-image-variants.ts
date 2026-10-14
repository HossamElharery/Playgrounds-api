/** Local-disk uploads only. Dry-run by default; pass --apply to write the WebP variants.
 * Run with: node --env-file=.env -r ts-node/register src/scripts/backfill-blog-image-variants.ts --apply
 * Covers every blog cover and every inline <img> in blog content. No database rows change: variant
 * URLs are derived from the original URL, and the originals stay untouched. Safe to run repeatedly.
 */
import { PrismaClient } from '../generated/prisma';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  IMAGE_VARIANT_WIDTHS,
  imageVariantKey,
  warmImageVariants,
} from '../modules/storage/image-variants';

const UPLOAD_URL =
  /\/uploads\/([a-z0-9-]+\/[a-z0-9-]+\.(?:png|jpe?g|webp|avif))/gi;

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
  const root = join(process.cwd(), 'uploads');
  const prisma = new PrismaClient();
  try {
    const posts = await prisma.blogPost.findMany({
      select: { coverImageUrl: true, contentEn: true, contentAr: true },
    });
    const keys = new Set<string>();
    for (const post of posts) {
      const text = [
        post.coverImageUrl ?? '',
        post.contentEn,
        post.contentAr,
      ].join('\n');
      for (const match of text.matchAll(UPLOAD_URL)) {
        if (imageVariantKey(match[1], IMAGE_VARIANT_WIDTHS[0]))
          keys.add(match[1]);
      }
    }
    let missingOriginal = 0;
    let missingVariants = 0;
    for (const key of keys) {
      if (!(await exists(join(root, key)))) {
        missingOriginal++;
        console.warn(`Original missing: ${key}`);
        continue;
      }
      for (const width of IMAGE_VARIANT_WIDTHS) {
        if (!(await exists(join(root, imageVariantKey(key, width)!))))
          missingVariants++;
      }
      if (apply) await warmImageVariants(root, key);
    }
    console.log(
      `${posts.length} posts, ${keys.size} blog images; ${apply ? 'wrote' : 'would write'} ${missingVariants} variants` +
        (missingOriginal ? `; ${missingOriginal} originals missing` : '') +
        '. Originals retained.',
    );
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Variant backfill failed',
  );
  process.exitCode = 1;
});
