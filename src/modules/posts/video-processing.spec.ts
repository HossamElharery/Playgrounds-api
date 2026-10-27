import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsTranscode, optimizeVideo, prepareVideo, withTempDir, type VideoProbe } from './video-processing';

const hasFfmpeg = (() => {
  try {
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function clip(args: string[], seconds = 2): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'video-spec-'));
  const file = join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', String(seconds), ...args, file], { stdio: 'ignore' });
  const buffer = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
  return buffer;
}

/** Writes the bytes to a temp file and hands its path to `work`, like an upload on disk. */
function onDisk<T>(bytes: Buffer, work: (file: string, dir: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const file = join(dir, 'upload.mp4');
    writeFileSync(file, bytes);
    return work(file, dir);
  });
}

const moovFirst = (video: Buffer) => video.indexOf('moov') < video.indexOf('mdat');

describe('needsTranscode', () => {
  const ok: VideoProbe = {
    width: 1080, height: 1920, durationSeconds: 20, videoCodec: 'h264', pixelFormat: 'yuv420p',
    audioCodec: 'aac', fps: 30, bitRate: 3_000_000, rotation: 0,
  };
  it('keeps web-ready H.264 as it is', () => {
    expect(needsTranscode(ok)).toBe(false);
    expect(needsTranscode({ ...ok, audioCodec: null })).toBe(false);
  });
  it.each([
    ['HEVC from an iPhone', { videoCodec: 'hevc' }],
    ['4K', { width: 2160, height: 3840 }],
    ['10-bit colour', { pixelFormat: 'yuv420p10le' }],
    ['Opus audio', { audioCodec: 'opus' }],
    ['120 fps', { fps: 120 }],
    ['a heavy bitrate', { bitRate: 7_400_000 }],
    ['a rotation flag', { rotation: 90 }],
  ])('re-encodes %s', (_label, change) => {
    expect(needsTranscode({ ...ok, ...change })).toBe(true);
  });
});

(hasFfmpeg ? describe : describe.skip)('video files', () => {
  // ffmpeg shares the CPU with every other suite in a full run.
  jest.setTimeout(120_000);

  it('prepareVideo returns a JPEG poster and a faststart remux', async () => {
    await onDisk(clip(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']), async (file, dir) => {
      const result = await prepareVideo(file, 'video/mp4', dir);
      expect(result.poster?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(moovFirst(readFileSync(result.videoPath!))).toBe(true);
      expect(result.probe).toMatchObject({ width: 320, height: 240 });
      expect(Math.round(result.probe!.durationSeconds)).toBe(2);
    });
  });

  it('optimizeVideo only remuxes a web-ready file', async () => {
    await onDisk(clip(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']), async (file, dir) => {
      const result = await optimizeVideo(file, dir);
      expect(result?.transcoded).toBe(false);
      expect(result?.probe).toMatchObject({ width: 320, height: 240, videoCodec: 'h264', audioCodec: 'aac' });
      expect(moovFirst(readFileSync(result!.videoPath))).toBe(true);
    });
  });

  it('optimizeVideo re-encodes an oversized 4:2:2 clip to 1080p H.264 yuv420p', async () => {
    const big = clip(['-vf', 'scale=2560:1440', '-c:v', 'libx264', '-pix_fmt', 'yuv422p', '-c:a', 'aac']);
    await onDisk(big, async (file, dir) => {
      const result = await optimizeVideo(file, dir);
      expect(result?.transcoded).toBe(true);
      expect(result?.probe).toMatchObject({ width: 1920, height: 1080, videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'aac' });
      expect(result?.poster?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(moovFirst(readFileSync(result!.videoPath))).toBe(true);
    });
  });

  it('returns nothing for bytes that are not a video', async () => {
    await onDisk(Buffer.from('nope'), async (file, dir) => {
      expect(await prepareVideo(file, 'video/mp4', dir)).toEqual({ probe: null, poster: undefined });
      expect(await optimizeVideo(file, dir)).toBeNull();
    });
  });
});
