/** Local-disk uploads only. Dry-run by default; pass --apply to update thumbnail URLs.
 * Run with: node --env-file=.env -r ts-node/register src/scripts/backfill-post-thumbnails.ts --apply
 * Originals and full-size URLs are never overwritten. Safe to run repeatedly.
 */
import { PrismaClient } from '../generated/prisma';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { createPostThumbnail } from '../modules/posts/post-thumbnail';

async function main() {
  if (process.env.STORAGE_PROVIDER === 's3')
    throw new Error(
      'Use the storage migration workflow for S3; this script only handles local uploads.',
    );
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  const base = (process.env.STORAGE_LOCAL_PUBLIC_BASE || '/uploads').replace(
    /\/$/,
    '',
  );
  let count = 0;
  let saved = 0;
  try {
    let cursor: string | undefined;
    while (true) {
      const rows = await prisma.postMedia.findMany({
        where: { type: 'image' },
        orderBy: { id: 'asc' },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, assetId: true, url: true, thumbnailUrl: true },
      });
      if (!rows.length) break;
      for (const row of rows) {
        if (row.thumbnailUrl && row.thumbnailUrl !== row.url) continue;
        if (!row.url.startsWith(`${base}/`)) continue;
        const key = row.url.slice(base.length + 1);
        if (!/^posts\/[a-z0-9-]+\.(?:png|jpe?g|webp|avif)$/i.test(key))
          continue;
        const source = await readFile(join(process.cwd(), 'uploads', key));
        const thumbnail = await createPostThumbnail(source);
        const thumbKey = `posts/thumbnails/${basename(key, extname(key))}-192.webp`;
        if (apply) {
          const target = join(process.cwd(), 'uploads', thumbKey);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, thumbnail);
          const thumbnailUrl = `${base}/${thumbKey}`;
          await prisma.$transaction([
            prisma.postMedia.updateMany({
              where: { id: row.id, thumbnailUrl: row.thumbnailUrl },
              data: { thumbnailUrl },
            }),
            ...(row.assetId
              ? [
                  prisma.mediaAsset.updateMany({
                    where: { id: row.assetId, url: row.url },
                    data: { thumbnailUrl },
                  }),
                ]
              : []),
          ]);
        }
        count++;
        saved += source.length - thumbnail.length;
      }
      cursor = rows[rows.length - 1].id;
    }
    console.log(
      `${apply ? 'Updated' : 'Would update'} ${count} thumbnails; ${(saved / 1024).toFixed(1)} KiB saved. Originals retained.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Thumbnail backfill failed',
  );
  process.exitCode = 1;
});
