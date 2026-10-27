import { extname } from 'node:path';
import type { PrismaClient } from '../../generated/prisma';
import type { StorageService } from '../storage/storage.service';
import { OPTIMIZED_VIDEO_PREFIX, optimizeVideo, type VideoProbe } from './video-processing';

type VideoRows = Pick<PrismaClient, 'postMedia' | 'mediaAsset' | '$transaction'>;
type VideoStorage = Pick<StorageService, 'readObject' | 'uploadBuffer' | 'deleteObject' | 'keyFromUrl' | 'urlFor'>;

export type OptimizeOutcome = 'optimized' | 'remuxed' | 'already-optimized' | 'not-stored-here' | 'unreadable' | 'superseded';

export interface OptimizeResult {
  outcome: OptimizeOutcome;
  url: string;
  newUrl?: string;
  beforeBytes?: number;
  afterBytes?: number;
  probe?: VideoProbe;
  /** Set when the original is no longer referenced and may be removed. */
  originalKey?: string;
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** Whether a stored video already went through optimizeStoredVideo. */
export function isOptimizedVideoUrl(url: string): boolean {
  return url.includes(`/${OPTIMIZED_VIDEO_PREFIX}/`);
}

/**
 * Re-encodes one stored video to the web target, stores it under posts/videos, and points every
 * MediaAsset and PostMedia row that used the old URL at the new file (also filling a missing
 * poster and the real width, height and duration). Safe to run twice: rows are matched on the old
 * URL, so a second run finds nothing and removes its own copy.
 * With apply=false it only reports what would happen.
 */
export async function optimizeStoredVideo(
  prisma: VideoRows,
  storage: VideoStorage,
  url: string,
  apply: boolean,
): Promise<OptimizeResult> {
  if (isOptimizedVideoUrl(url)) return { outcome: 'already-optimized', url };
  const key = storage.keyFromUrl(url);
  if (!key) return { outcome: 'not-stored-here', url };
  const source = await storage.readObject(key).catch(() => null);
  if (!source) return { outcome: 'unreadable', url };
  const result = await optimizeVideo(source, MIME[extname(key).toLowerCase()] ?? 'video/mp4');
  if (!result) return { outcome: 'unreadable', url, beforeBytes: source.length };
  const report: OptimizeResult = {
    outcome: result.transcoded ? 'optimized' : 'remuxed',
    url,
    beforeBytes: source.length,
    afterBytes: result.video.length,
    probe: result.probe,
  };
  if (!apply) return report;

  const uploaded = await storage.uploadBuffer(result.video, 'video.mp4', 'video/mp4', OPTIMIZED_VIDEO_PREFIX);
  const missingPoster = { url, thumbnailUrl: { in: [url, ''] } };
  const needsPoster =
    (await prisma.postMedia.count({ where: missingPoster })) +
      (await prisma.mediaAsset.count({ where: { OR: [missingPoster, { url, thumbnailUrl: null }] } })) >
    0;
  const poster =
    needsPoster && result.poster
      ? await storage.uploadBuffer(result.poster, 'poster.jpg', 'image/jpeg', 'posts/thumbnails')
      : null;
  const size = {
    width: result.probe.width,
    height: result.probe.height,
    durationSeconds: Math.max(1, Math.round(result.probe.durationSeconds)),
  };
  const [, , media, assets] = await prisma.$transaction([
    prisma.postMedia.updateMany({
      where: poster ? missingPoster : { id: '__none__' },
      data: { thumbnailUrl: poster?.url ?? '' },
    }),
    prisma.mediaAsset.updateMany({
      where: poster ? { OR: [missingPoster, { url, thumbnailUrl: null }] } : { id: '__none__' },
      data: { thumbnailUrl: poster?.url ?? '' },
    }),
    prisma.postMedia.updateMany({ where: { url }, data: { url: uploaded.url, ...size } }),
    prisma.mediaAsset.updateMany({
      where: { url },
      data: { url: uploaded.url, key: uploaded.key, mimeType: 'video/mp4', ...size },
    }),
  ]);
  if (media.count + assets.count === 0) {
    // Another worker swapped these rows first.
    await storage.deleteObject(uploaded.key).catch(() => undefined);
    if (poster) await storage.deleteObject(poster.key).catch(() => undefined);
    return { ...report, outcome: 'superseded' };
  }
  return { ...report, newUrl: uploaded.url, originalKey: key };
}

/** Deletes a replaced original once no row points at it any more. */
export async function deleteOriginalIfUnused(
  prisma: VideoRows,
  storage: VideoStorage,
  url: string,
  key: string,
): Promise<boolean> {
  const refs =
    (await prisma.postMedia.count({ where: { url } })) + (await prisma.mediaAsset.count({ where: { url } }));
  if (refs > 0) return false;
  await storage.deleteObject(key);
  return true;
}
