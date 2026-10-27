import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { OPTIMIZED_VIDEO_PREFIX } from './video-processing';
import { deleteOriginalIfUnused, optimizeStoredVideo } from './video-optimizer';

/** Readers of a cached page may still request the old file for a few minutes after the swap. */
const DELETE_ORIGINAL_AFTER_MS = 10 * 60_000;

/**
 * Runs video optimization one file at a time, off the request path: after each upload, and once
 * after boot for every stored video that was never optimized (older uploads, or a job lost to a
 * restart). Disable with VIDEO_OPTIMIZER=off.
 */
@Injectable()
export class VideoOptimizerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(VideoOptimizerService.name);
  private readonly queued = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private chain: Promise<void> = Promise.resolve();
  private ffmpegReady?: Promise<boolean>;
  private readonly enabled: boolean;
  private readonly sweepDelayMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('VIDEO_OPTIMIZER') !== 'off' && process.env.NODE_ENV !== 'test';
    this.sweepDelayMs = Number(config.get<string>('VIDEO_OPTIMIZER_SWEEP_DELAY_MS') ?? 60_000);
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    const timer = setTimeout(() => void this.sweep(), this.sweepDelayMs);
    timer.unref();
    this.timers.add(timer);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }

  /** Queues a stored video URL; repeated calls for the same URL are ignored. */
  enqueue(url: string): void {
    if (!this.enabled || !url || this.queued.has(url) || this.failed.has(url)) return;
    this.queued.add(url);
    this.chain = this.chain.then(() => this.process(url)).catch(() => undefined);
  }

  /** Resolves when everything queued so far has finished (used by tests and scripts). */
  idle(): Promise<void> {
    return this.chain;
  }

  async sweep(): Promise<void> {
    if (!(await this.hasFfmpeg())) return;
    const notOptimized = { type: 'video' as const, NOT: { url: { contains: `/${OPTIMIZED_VIDEO_PREFIX}/` } } };
    const [media, assets] = await Promise.all([
      this.prisma.postMedia.findMany({ where: notOptimized, select: { url: true }, distinct: ['url'], take: 500 }),
      this.prisma.mediaAsset.findMany({
        where: { ...notOptimized, status: 'ready' },
        select: { url: true },
        distinct: ['url'],
        take: 500,
      }),
    ]);
    const urls = new Set([...media, ...assets].map((row) => row.url));
    if (urls.size) this.logger.log(`Optimizing ${urls.size} stored video(s)`);
    for (const url of urls) this.enqueue(url);
  }

  private async process(url: string): Promise<void> {
    try {
      if (!(await this.hasFfmpeg())) return;
      const started = Date.now();
      const result = await optimizeStoredVideo(this.prisma, this.storage, url, true);
      if (result.outcome === 'unreadable') {
        this.failed.add(url);
        this.logger.warn(`Video could not be optimized: ${url}`);
        return;
      }
      if (!result.newUrl || !result.originalKey) return;
      const mb = (bytes = 0) => (bytes / 1024 / 1024).toFixed(1);
      this.logger.log(
        `Video ${result.outcome} in ${Math.round((Date.now() - started) / 1000)}s: ` +
          `${mb(result.beforeBytes)} MB -> ${mb(result.afterBytes)} MB, ${result.probe?.width}x${result.probe?.height}`,
      );
      const key = result.originalKey;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void deleteOriginalIfUnused(this.prisma, this.storage, url, key).catch(() => undefined);
      }, DELETE_ORIGINAL_AFTER_MS);
      timer.unref();
      this.timers.add(timer);
    } catch (error) {
      this.failed.add(url);
      this.logger.warn(`Video optimization failed for ${url}: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.queued.delete(url);
    }
  }

  private hasFfmpeg(): Promise<boolean> {
    this.ffmpegReady ??= new Promise<boolean>((resolve) => {
      const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    }).then((ok) => {
      if (!ok) this.logger.warn('ffmpeg is not installed; uploaded videos stay as uploaded');
      return ok;
    });
    return this.ffmpegReady;
  }
}
