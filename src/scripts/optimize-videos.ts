/**
 * Manual run of the video optimizer the API already runs on its own after each boot.
 * Useful to see what it would do, or to force it when VIDEO_OPTIMIZER=off.
 *
 *   node dist/src/scripts/optimize-videos.js            # report only
 *   node dist/src/scripts/optimize-videos.js --apply    # re-encode, swap rows, keep originals
 *   node dist/src/scripts/optimize-videos.js --apply --delete-originals
 */
import { PrismaClient } from '../generated/prisma';
import { LocalDiskStorageProvider } from '../modules/storage/local-disk-storage.provider';
import { S3StorageProvider } from '../modules/storage/s3-storage.provider';
import { StorageService } from '../modules/storage/storage.service';
import { OPTIMIZED_VIDEO_PREFIX } from '../modules/posts/video-processing';
import { deleteOriginalIfUnused, optimizeStoredVideo } from '../modules/posts/video-optimizer';

const config = { get: <T>(key: string, fallback?: T) => (process.env[key] as T | undefined) ?? fallback } as never;
const mb = (bytes = 0) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const apply = process.argv.includes('--apply');
  const deleteOriginals = process.argv.includes('--delete-originals');
  const prisma = new PrismaClient();
  const storage = new StorageService(
    process.env.STORAGE_PROVIDER === 's3' ? new S3StorageProvider(config) : new LocalDiskStorageProvider(config),
  );
  try {
    const notOptimized = { type: 'video' as const, NOT: { url: { contains: `/${OPTIMIZED_VIDEO_PREFIX}/` } } };
    const rows = [
      ...(await prisma.postMedia.findMany({ where: notOptimized, select: { url: true }, distinct: ['url'] })),
      ...(await prisma.mediaAsset.findMany({ where: { ...notOptimized, status: 'ready' }, select: { url: true }, distinct: ['url'] })),
    ];
    const urls = [...new Set(rows.map((row) => row.url))];
    console.log(`${urls.length} video(s) not optimized yet${apply ? '' : ' (report only; add --apply to change them)'}`);
    let saved = 0;
    for (const url of urls) {
      const result = await optimizeStoredVideo(prisma, storage, url, apply);
      const size = result.afterBytes ? `${mb(result.beforeBytes)} -> ${mb(result.afterBytes)}` : '';
      const dims = result.probe ? `${result.probe.width}x${result.probe.height}, ${Math.round(result.probe.durationSeconds)}s` : '';
      console.log(`${result.outcome.padEnd(17)} ${url} ${size} ${dims}${result.newUrl ? ` => ${result.newUrl}` : ''}`);
      if (result.afterBytes && result.beforeBytes) saved += result.beforeBytes - result.afterBytes;
      if (apply && deleteOriginals && result.originalKey) {
        const removed = await deleteOriginalIfUnused(prisma, storage, url, result.originalKey);
        if (removed) console.log(`  removed original ${result.originalKey}`);
      }
    }
    console.log(`${apply ? 'Saved' : 'Would save'} ${mb(saved)}.${apply && !deleteOriginals ? ' Originals kept on disk.' : ''}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Video optimization failed');
  process.exitCode = 1;
});
