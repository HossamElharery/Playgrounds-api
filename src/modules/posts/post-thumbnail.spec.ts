// The backend uses legacy CommonJS resolution; sharp's runtime export is callable.
const sharp: typeof import('sharp').default = require('sharp');
import { createPostThumbnail } from './post-thumbnail';

describe('post thumbnails', () => {
  it('creates a small retina thumbnail without changing the original', async () => {
    const source = await sharp({
      create: { width: 427, height: 427, channels: 3, background: '#177544' },
    })
      .png()
      .toBuffer();
    const before = Buffer.from(source);
    const result = await createPostThumbnail(source);
    expect(await sharp(result).metadata()).toMatchObject({
      width: 192,
      height: 192,
      format: 'webp',
    });
    expect(source.equals(before)).toBe(true);
    expect(result.length).toBeLessThan(source.length);
  });
  it('does not enlarge small images', async () => {
    const source = await sharp({
      create: { width: 48, height: 48, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    expect(
      await sharp(await createPostThumbnail(source)).metadata(),
    ).toMatchObject({ width: 48, height: 48 });
  });
  it('rejects a non-image payload', async () => {
    await expect(
      createPostThumbnail(Buffer.from('not an image')),
    ).rejects.toThrow();
  });
});
