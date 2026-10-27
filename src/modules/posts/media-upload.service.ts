import {
  BadRequestException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { appendFile, mkdir, readdir, rm, stat, writeFile } from 'fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { createPostThumbnail } from './post-thumbnail';
import { hasVideoTools, prepareVideo, withTempDir } from './video-processing';
import { VideoOptimizerService } from './video-optimizer.service';
import { RequestUploadDto } from './dto/request-upload.dto';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** A 90 s 4K phone clip; everything is re-encoded to about 4 Mb/s after upload. */
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
/** The single-request endpoint holds the file in memory, so it keeps the old cap. */
export const SINGLE_UPLOAD_MAX_BYTES = 80 * 1024 * 1024;
/** Small enough to finish well inside proxy timeouts on a slow phone connection. */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 90;
/**
 * Chunks land on this instance's disk, so the API must run as a single instance
 * (or with sticky routing) while chunked uploads are in flight.
 */
const PARTS_DIR = join(tmpdir(), 'matchena-uploads');
const STALE_PART_MS = 6 * 60 * 60_000;

interface StoredFile {
  path: string;
  size: number;
  mimeType: string;
  originalName: string;
}

@Injectable()
export class MediaUploadService implements OnModuleInit, OnModuleDestroy {
  private readonly partLocks = new Map<string, Promise<unknown>>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Optional() private readonly videoOptimizer?: VideoOptimizerService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    void this.removeStaleParts();
    this.sweepTimer = setInterval(() => void this.removeStaleParts(), 60 * 60_000);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  async requestUpload(userId: string, dto: RequestUploadDto) {
    this.validateMeta(dto);
    const ext = extname(dto.filename) || (dto.type === 'video' ? '.mp4' : '.jpg');
    const key = `posts/${randomUUID()}${ext}`;
    const asset = await this.prisma.mediaAsset.create({
      data: {
        userId,
        type: dto.type,
        key,
        url: this.storage.urlFor(key),
        thumbnailUrl: dto.type === 'image' ? this.storage.urlFor(key) : '',
        mimeType: dto.mimeType,
        width: dto.width ?? 0,
        height: dto.height ?? 0,
        durationSeconds: dto.durationSeconds,
        altText: dto.altText,
        status: 'pending',
      },
    });
    if (dto.type === 'video') {
      // Older apps read only uploadUrl/mode and fall back to the single-request endpoint.
      return {
        assetId: asset.id,
        uploadUrl: `/api/v1/media/uploads/${asset.id}/file`,
        method: 'POST' as const,
        headers: {},
        mode: 'chunked' as const,
        chunkUrl: `/api/v1/media/uploads/${asset.id}/chunks`,
        chunkBytes: UPLOAD_CHUNK_BYTES,
      };
    }
    return {
      assetId: asset.id,
      uploadUrl: `/api/v1/media/uploads/${asset.id}/file`,
      method: 'POST' as const,
      headers: {},
      mode: 'multipart' as const,
    };
  }

  async receiveFile(
    userId: string,
    assetId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  ) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, userId },
    });
    if (!asset) throw new BadRequestException('Unknown upload');
    this.validateMeta({
      filename: file.originalname,
      mimeType: file.mimetype,
      byteSize: file.size,
      type: asset.type,
      durationSeconds: asset.durationSeconds ?? undefined,
    });
    if (asset.type === 'video') {
      return withTempDir(async (dir) => {
        const path = join(dir, `upload${this.safeExt(file.originalname)}`);
        await writeFile(path, file.buffer);
        return this.storeVideo(assetId, {
          path,
          size: file.size,
          mimeType: file.mimetype,
          originalName: file.originalname,
        });
      });
    }
    let thumbnail: Buffer;
    try {
      thumbnail = await createPostThumbnail(file.buffer);
    } catch {
      throw new BadRequestException('Invalid image or image dimensions are too large');
    }
    const uploaded = await this.storage.uploadBuffer(
      file.buffer,
      file.originalname,
      file.mimetype,
      'posts',
    );
    const preview = await this.storage.uploadBuffer(
      thumbnail,
      'preview.webp',
      'image/webp',
      'posts/thumbnails',
    );
    return this.prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        key: uploaded.key,
        url: uploaded.url,
        thumbnailUrl: preview.url || uploaded.url,
        mimeType: file.mimetype,
        status: 'ready',
      },
    });
  }

  /** Bytes already received for a chunked video upload; clients resume from here. */
  async chunkStatus(userId: string, assetId: string) {
    await this.pendingVideo(userId, assetId);
    return { received: await this.partSize(assetId) };
  }

  /**
   * Appends one chunk at `offset`. A retried chunk that already landed is accepted as-is,
   * and any other gap or overlap is refused with the size received so far.
   */
  async receiveChunk(userId: string, assetId: string, offset: number, chunk: Buffer) {
    await this.pendingVideo(userId, assetId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !chunk?.length) {
      throw new BadRequestException('Invalid chunk');
    }
    if (offset + chunk.length > MAX_VIDEO_BYTES) throw new PayloadTooLargeException('Video is too large');
    return this.withPartLock(assetId, async () => {
      const received = await this.partSize(assetId);
      if (offset + chunk.length <= received) return { received };
      if (offset !== received) {
        throw new BadRequestException({ message: 'Upload offset mismatch', received });
      }
      await mkdir(PARTS_DIR, { recursive: true });
      await appendFile(this.partPath(assetId), chunk);
      return { received: received + chunk.length };
    });
  }

  /** Processes the assembled chunks like a single-request upload, then drops them. */
  async finishChunks(userId: string, assetId: string) {
    const done = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, userId, type: 'video', status: 'ready' },
    });
    // A retry after a dropped response must not fail an upload that already went through.
    if (done) return done;
    const asset = await this.pendingVideo(userId, assetId);
    return this.withPartLock(assetId, async () => {
      const path = this.partPath(assetId);
      const size = await this.partSize(assetId);
      if (!size) throw new BadRequestException('Upload is empty');
      try {
        return await this.storeVideo(assetId, {
          path,
          size,
          mimeType: asset.mimeType,
          originalName: `video${extname(asset.key)}`,
        });
      } finally {
        await rm(path, { force: true }).catch(() => undefined);
      }
    });
  }

  async complete(userId: string, assetId: string) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, userId },
    });
    if (!asset) throw new BadRequestException('Unknown upload');
    const thumbnailUrl =
      asset.type === 'video' && !asset.thumbnailUrl
        ? asset.url
        : asset.thumbnailUrl || asset.url;
    const ready = await this.prisma.mediaAsset.update({
      where: { id: assetId },
      data: { status: 'ready', thumbnailUrl },
    });
    if (asset.type === 'video') this.videoOptimizer?.enqueue(ready.url);
    return ready;
  }

  /**
   * Checks the real file (the client's duration is only a hint), stores a faststart copy and a
   * poster, and records the measured size and length. The H.264 re-encode swaps the file in later.
   */
  private async storeVideo(assetId: string, file: StoredFile) {
    this.validateMeta({
      filename: file.originalName,
      mimeType: file.mimeType,
      byteSize: file.size,
      type: 'video',
    });
    return withTempDir(async (dir) => {
      const video = await prepareVideo(file.path, file.mimeType, dir);
      if (!video.probe && (await hasVideoTools())) {
        throw new BadRequestException('This file is not a playable video');
      }
      if (video.probe && Math.round(video.probe.durationSeconds) > MAX_VIDEO_SECONDS) {
        throw new BadRequestException('Video must be 90 seconds or shorter');
      }
      const uploaded = await this.storage.uploadFile(
        video.videoPath ?? file.path,
        file.originalName,
        file.mimeType,
        'posts',
      );
      const poster = video.poster
        ? await this.storage.uploadBuffer(video.poster, 'poster.jpg', 'image/jpeg', 'posts/thumbnails')
        : null;
      const measured = video.probe
        ? {
            width: video.probe.width,
            height: video.probe.height,
            durationSeconds: Math.max(1, Math.round(video.probe.durationSeconds)),
          }
        : {};
      const ready = await this.prisma.mediaAsset.update({
        where: { id: assetId },
        data: {
          key: uploaded.key,
          url: uploaded.url,
          thumbnailUrl: poster?.url || uploaded.url,
          mimeType: file.mimeType,
          status: 'ready',
          ...measured,
        },
      });
      this.videoOptimizer?.enqueue(ready.url);
      return ready;
    });
  }

  private async pendingVideo(userId: string, assetId: string) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, userId },
    });
    if (!asset || asset.type !== 'video' || asset.status !== 'pending') {
      throw new BadRequestException('Unknown upload');
    }
    return asset;
  }

  private partPath(assetId: string): string {
    // Asset ids are UUIDs; anything else never reaches the disk.
    if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new BadRequestException('Unknown upload');
    return join(PARTS_DIR, `${assetId}.part`);
  }

  private partSize(assetId: string): Promise<number> {
    return stat(this.partPath(assetId)).then(
      (s) => s.size,
      () => 0,
    );
  }

  private async withPartLock<T>(assetId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.partLocks.get(assetId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.partLocks.set(assetId, next);
    try {
      return await next;
    } finally {
      if (this.partLocks.get(assetId) === next) this.partLocks.delete(assetId);
    }
  }

  private async removeStaleParts(): Promise<void> {
    const names = await readdir(PARTS_DIR).catch(() => [] as string[]);
    const cutoff = Date.now() - STALE_PART_MS;
    for (const name of names) {
      const path = join(PARTS_DIR, name);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(path, { force: true }).catch(() => undefined);
    }
  }

  private safeExt(name: string): string {
    const ext = extname(name).toLowerCase();
    return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '';
  }

  private validateMeta(dto: {
    filename: string;
    mimeType: string;
    byteSize: number;
    type: 'image' | 'video';
    durationSeconds?: number;
  }) {
    if (dto.type === 'image') {
      if (!IMAGE_TYPES.has(dto.mimeType)) {
        throw new BadRequestException('Unsupported image type');
      }
      if (dto.byteSize > MAX_IMAGE_BYTES) {
        throw new BadRequestException('Image is too large');
      }
    } else {
      if (!VIDEO_TYPES.has(dto.mimeType)) {
        throw new BadRequestException('Unsupported video type');
      }
      if (dto.byteSize > MAX_VIDEO_BYTES) {
        throw new BadRequestException('Video is too large');
      }
      if ((dto.durationSeconds ?? 0) > MAX_VIDEO_SECONDS) {
        throw new BadRequestException('Video must be 90 seconds or shorter');
      }
    }
  }
}
