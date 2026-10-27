import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const TIMEOUT_MS = 60_000;

export interface PreparedVideo {
  /** The same streams with the moov index moved to the front (MP4/MOV only). */
  video?: Buffer;
  /** A JPEG frame, at most 1280px wide, for posters, og:image and VideoObject.thumbnailUrl. */
  poster?: Buffer;
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr}`));
    });
  });
}

/**
 * Makes an uploaded video playable before it is fully downloaded and gives it a poster frame.
 * Search engines only index a video that has a thumbnail, and a moov atom at the end of the
 * file forces browsers and crawlers to fetch the tail before the first frame.
 * Returns an empty object when ffmpeg is missing or the file can't be read, so uploads still work.
 */
export async function prepareVideo(buffer: Buffer, mimeType: string): Promise<PreparedVideo> {
  const dir = await mkdtemp(join(tmpdir(), 'matchena-video-'));
  const ext = mimeType === 'video/webm' ? 'webm' : mimeType === 'video/quicktime' ? 'mov' : 'mp4';
  const input = join(dir, `in.${ext}`);
  const remuxed = join(dir, `out.${ext}`);
  const poster = join(dir, 'poster.jpg');
  const result: PreparedVideo = {};
  try {
    await writeFile(input, buffer);
    try {
      // A frame one second in skips black fades; tiny clips fall back to the first frame.
      await run(['-y', '-ss', '1', '-i', input, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', poster])
        .catch(() => run(['-y', '-i', input, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', poster]));
      result.poster = await readFile(poster);
    } catch {
      // No poster: the caller keeps the old behaviour.
    }
    if (ext !== 'webm') {
      try {
        await run(['-y', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', remuxed]);
        const out = await readFile(remuxed);
        if (out.length > 0) result.video = out;
      } catch {
        // Keep the original bytes.
      }
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
