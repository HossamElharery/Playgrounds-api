import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareVideo } from './video-poster';

const hasFfmpeg = (() => {
  try {
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

(hasFfmpeg ? describe : describe.skip)('prepareVideo', () => {
  it('returns a JPEG poster and a faststart remux', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poster-spec-'));
    const file = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
    const result = await prepareVideo(readFileSync(file), 'video/mp4');
    rmSync(dir, { recursive: true, force: true });
    expect(result.poster?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const video = result.video!;
    // ftyp first, then moov before mdat.
    expect(video.indexOf('moov')).toBeLessThan(video.indexOf('mdat'));
  });

  it('returns nothing for bytes that are not a video', async () => {
    expect(await prepareVideo(Buffer.from('nope'), 'video/mp4')).toEqual({});
  });
});
