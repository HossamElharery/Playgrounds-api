import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const THREADS = process.env.FFMPEG_THREADS || '2';
const QUICK_TIMEOUT_MS = 60_000;
const TRANSCODE_TIMEOUT_MS = 15 * 60_000;

/** Optimized files live under this prefix; anything else is still the raw upload. */
export const OPTIMIZED_VIDEO_PREFIX = 'posts/videos';

/** The web target: what every browser, Googlebot and social previews play without surprises. */
export const VIDEO_TARGET = {
  longSide: 1920,
  shortSide: 1080,
  maxFps: 60,
  /** Above this total bitrate a re-encode pays for itself (a 30 s phone clip was 7.4 Mb/s). */
  maxBitRate: 5_000_000,
} as const;

/** True when a video row has its own poster image instead of the mp4 copied into thumbnailUrl. */
export function isPosterUrl(thumbnailUrl: string | null | undefined, url: string): boolean {
  return !!thumbnailUrl && thumbnailUrl !== url && /\.(jpe?g|png|webp|avif)(\?|$)/i.test(thumbnailUrl);
}

export interface PreparedVideo {
  /** The same streams with the moov index moved to the front and location tags removed (MP4/MOV only). */
  video?: Buffer;
  /** A JPEG frame, at most 1280px wide, for posters, og:image and VideoObject.thumbnailUrl. */
  poster?: Buffer;
}

export interface VideoProbe {
  /** Display size, after any rotation flag. */
  width: number;
  height: number;
  durationSeconds: number;
  videoCodec: string;
  pixelFormat: string;
  audioCodec: string | null;
  fps: number;
  bitRate: number;
  rotation: number;
}

export interface OptimizedVideo {
  video: Buffer;
  poster?: Buffer;
  probe: VideoProbe;
  transcoded: boolean;
}

function run(cmd: string, args: string[], timeoutMs: number, capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited with ${code}: ${stderr}`));
    });
  });
}

const ffmpeg = (args: string[], timeoutMs = QUICK_TIMEOUT_MS) =>
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], timeoutMs);

function extFor(mimeType: string): string {
  return mimeType === 'video/webm' ? 'webm' : mimeType === 'video/quicktime' ? 'mov' : 'mp4';
}

async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'matchena-video-'));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function posterFrom(input: string, output: string): Promise<Buffer | undefined> {
  const frame = ['-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', output];
  try {
    // A frame one second in skips black fades; tiny clips fall back to the first frame.
    await ffmpeg(['-ss', '1', '-i', input, ...frame]).catch(() => ffmpeg(['-i', input, ...frame]));
    const poster = await readFile(output);
    return poster.length ? poster : undefined;
  } catch {
    return undefined;
  }
}

export async function probeVideo(file: string): Promise<VideoProbe | null> {
  try {
    const out = await run(
      FFPROBE,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      QUICK_TIMEOUT_MS,
      true,
    );
    const data = JSON.parse(out) as {
      format?: { duration?: string; bit_rate?: string; size?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        pix_fmt?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        r_frame_rate?: string;
        tags?: { rotate?: string };
        side_data_list?: Array<{ rotation?: number }>;
      }>;
    };
    const video = data.streams?.find((s) => s.codec_type === 'video');
    if (!video?.width || !video.height) return null;
    const audio = data.streams?.find((s) => s.codec_type === 'audio');
    const rotation = Math.abs(
      Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0),
    ) % 360;
    const sideways = rotation === 90 || rotation === 270;
    const rate = (video.avg_frame_rate && video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : video.r_frame_rate) ?? '0/1';
    const [num, den] = rate.split('/').map(Number);
    const durationSeconds = Number(data.format?.duration) || 0;
    const bitRate =
      Number(data.format?.bit_rate) ||
      (durationSeconds ? Math.round((Number(data.format?.size) * 8) / durationSeconds) : 0);
    return {
      width: sideways ? video.height : video.width,
      height: sideways ? video.width : video.height,
      durationSeconds,
      videoCodec: video.codec_name ?? '',
      pixelFormat: video.pix_fmt ?? '',
      audioCodec: audio?.codec_name ?? null,
      fps: den ? num / den : 0,
      bitRate,
      rotation,
    };
  } catch {
    return null;
  }
}

/** Whether a file already matches the web target, so a lossless remux is enough. */
export function needsTranscode(p: VideoProbe): boolean {
  const long = Math.max(p.width, p.height);
  const short = Math.min(p.width, p.height);
  return (
    p.videoCodec !== 'h264' ||
    p.pixelFormat !== 'yuv420p' ||
    (p.audioCodec !== null && p.audioCodec !== 'aac') ||
    long > VIDEO_TARGET.longSide ||
    short > VIDEO_TARGET.shortSide ||
    p.fps > VIDEO_TARGET.maxFps + 0.5 ||
    p.bitRate > VIDEO_TARGET.maxBitRate ||
    // Re-encoding bakes the rotation into the pixels; a rotation flag is easy to lose later.
    p.rotation !== 0
  );
}

/** Fits the frame in 1920×1080 (landscape) or 1080×1920 (portrait) and keeps the aspect ratio. */
const SCALE_FILTER =
  `scale='if(gte(iw,ih),min(${VIDEO_TARGET.longSide},iw),min(${VIDEO_TARGET.shortSide},iw))'` +
  `:'if(gte(iw,ih),min(${VIDEO_TARGET.shortSide},ih),min(${VIDEO_TARGET.longSide},ih))'` +
  ':force_original_aspect_ratio=decrease:force_divisible_by=2';

/**
 * Upload-time step, fast enough to run inside the request (a remux copies streams, no re-encode):
 * a poster frame plus a faststart copy without location tags.
 * Search engines only index a video that has a thumbnail, and a moov atom at the end of the
 * file forces browsers and crawlers to fetch the tail before the first frame.
 * Returns an empty object when ffmpeg is missing or the file can't be read, so uploads still work.
 */
export async function prepareVideo(buffer: Buffer, mimeType: string): Promise<PreparedVideo> {
  return withTempDir(async (dir) => {
    const ext = extFor(mimeType);
    const input = join(dir, `in.${ext}`);
    const remuxed = join(dir, `out.${ext}`);
    const result: PreparedVideo = {};
    await writeFile(input, buffer);
    result.poster = await posterFrom(input, join(dir, 'poster.jpg'));
    if (ext !== 'webm') {
      // Older ffmpeg keeps rotation as a stream tag, so tags are only dropped for upright clips;
      // the background transcode strips them from rotated ones.
      const upright = (await probeVideo(input))?.rotation === 0;
      try {
        await ffmpeg(['-i', input, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', ...(upright ? ['-map_metadata', '-1'] : []), '-movflags', '+faststart', remuxed]);
        const out = await readFile(remuxed);
        if (out.length > 0) result.video = out;
      } catch {
        // Keep the original bytes.
      }
    }
    return result;
  });
}

/**
 * Background step: turns any upload (HEVC from iPhones, WebM, 4K, 60+ fps, high bitrate) into
 * H.264 High / yuv420p / AAC in a faststart MP4 of at most 1080p, which plays everywhere and is
 * what Google's video indexing handles best. Files that already match are only remuxed.
 * Returns null when the file isn't a readable video or ffmpeg is unavailable.
 */
export async function optimizeVideo(buffer: Buffer, mimeType: string): Promise<OptimizedVideo | null> {
  return withTempDir(async (dir) => {
    const input = join(dir, `in.${extFor(mimeType)}`);
    const output = join(dir, 'out.mp4');
    await writeFile(input, buffer);
    const source = await probeVideo(input);
    if (!source) return null;
    const transcoded = needsTranscode(source);
    const common = ['-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-movflags', '+faststart'];
    try {
      if (transcoded) {
        await ffmpeg(
          [
            '-i', input, ...common,
            '-vf', SCALE_FILTER, '-fpsmax', String(VIDEO_TARGET.maxFps),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
            '-maxrate', '4M', '-bufsize', '8M',
            '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
            '-threads', THREADS,
            output,
          ],
          TRANSCODE_TIMEOUT_MS,
        );
      } else {
        await ffmpeg(['-i', input, ...common, '-c', 'copy', output]);
      }
    } catch {
      return null;
    }
    const probe = await probeVideo(output);
    const video = await readFile(output).catch(() => null);
    if (!probe || !video?.length) return null;
    return { video, poster: await posterFrom(output, join(dir, 'poster.jpg')), probe, transcoded };
  });
}
