import { PrismaClient } from '../generated/prisma';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { prepareVideo } from '../modules/posts/video-poster';
import { isPosterUrl } from '../modules/seo/sitemap.service';

const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

async function main() {
  if (process.env.STORAGE_PROVIDER === 's3')
    throw new Error('This script only handles local uploads.');
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  const base = (process.env.STORAGE_LOCAL_PUBLIC_BASE || '/uploads').replace(/\/$/, '');
  let posters = 0;
  let remuxed = 0;
  let skipped = 0;
  try {
    const rows = await prisma.postMedia.findMany({
      where: { type: 'video' },
      orderBy: { id: 'asc' },
      select: { id: true, assetId: true, url: true, thumbnailUrl: true },
    });
    for (const row of rows) {
      if (isPosterUrl(row.thumbnailUrl, row.url)) continue;
      const key = row.url.startsWith(`${base}/`) ? row.url.slice(base.length + 1) : '';
      if (!/^posts\/[a-z0-9-]+\.(?:mp4|m4v|mov|webm)$/i.test(key)) {
        skipped++;
        continue;
      }
      const path = join(process.cwd(), 'uploads', key);
      const source = await readFile(path).catch(() => null);
      if (!source) {
        console.log(`missing file: ${key}`);
        skipped++;
        continue;
      }
      const prepared = await prepareVideo(source, MIME[extname(key).toLowerCase()] ?? 'video/mp4');
      if (!prepared.poster) {
        console.log(`no poster frame: ${key}`);
        skipped++;
        continue;
      }
      const posterKey = `posts/thumbnails/${basename(key, extname(key))}-poster.jpg`;
      const thumbnailUrl = `${base}/${posterKey}`;
      console.log(`${apply ? 'poster' : 'would poster'} ${key} -> ${posterKey}${prepared.video ? ' (+faststart)' : ''}`);
      if (apply) {
        const target = join(process.cwd(), 'uploads', posterKey);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, prepared.poster);
        if (prepared.video) {
          // Same streams, index moved to the front; rename keeps readers of the old file safe.
          await writeFile(`${path}.faststart`, prepared.video);
          await rename(`${path}.faststart`, path);
          remuxed++;
        }
        await prisma.$transaction([
          prisma.postMedia.updateMany({ where: { id: row.id, thumbnailUrl: row.thumbnailUrl }, data: { thumbnailUrl } }),
          ...(row.assetId
            ? [prisma.mediaAsset.updateMany({ where: { id: row.assetId, url: row.url }, data: { thumbnailUrl } })]
            : []),
        ]);
      }
      posters++;
    }
    console.log(
      `${apply ? 'Updated' : 'Would update'} ${posters} video posters (${remuxed} remuxed for faststart); ${skipped} skipped.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Video poster backfill failed');
  process.exitCode = 1;
});
