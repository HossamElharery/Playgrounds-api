const sharp: typeof import('sharp').default = require('sharp');
import { OG_H, OG_W, renderChallengeOg } from './camo-og';

describe('challenge link preview card', () => {
  it('is a 1200x630 JPEG for every room, and an unknown room falls back to a plain one', async () => {
    for (const room of ['locker_room', 'five_a_side', 'ahwa', 'ramadan_alley', 'nope']) {
      const jpg = await renderChallengeOg(room, 5, 2);
      const meta = await sharp(jpg).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', OG_W, OG_H]);
      expect(jpg.length).toBeGreaterThan(5_000);
      expect(jpg.length).toBeLessThan(400_000);
    }
  });

  it('only the room and the counters change the picture: two hiders in the same room look identical', async () => {
    const a = await renderChallengeOg('ahwa', 3, 1);
    const b = await renderChallengeOg('ahwa', 3, 1);
    expect(a.equals(b)).toBe(true);
    const more = await renderChallengeOg('ahwa', 9, 4);
    expect(more.equals(a)).toBe(false);
  });

  it('survives absurd counters', async () => {
    const jpg = await renderChallengeOg('ahwa', 10_000, 99_999);
    expect((await sharp(jpg).metadata()).width).toBe(OG_W);
    await expect(renderChallengeOg('ahwa', -5, -1)).resolves.toBeInstanceOf(Buffer);
  });
});
