import { UnprocessableEntityException } from '@nestjs/common';
import { prepareUploadImage } from './upload-image';
const sharp: typeof import('sharp').default = require('sharp');

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#2a6' } })
    .png()
    .toBuffer();

describe('prepareUploadImage', () => {
  it('refuses a cover narrower than 1200px', async () => {
    await expect(
      prepareUploadImage(await png(499, 281), 'image/png', 'cover'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('refuses a file that is not an image', async () => {
    await expect(
      prepareUploadImage(Buffer.from('nope'), 'image/png', 'general'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('keeps a good image byte for byte and warns below the recommended width', async () => {
    const input = await png(1300, 600);
    const out = await prepareUploadImage(input, 'image/png', 'cover');
    expect(out.buffer).toBe(input);
    expect(out.width).toBe(1300);
    expect(out.warnings[0]).toContain('low_resolution');
  });

  it('does not warn at the recommended width', async () => {
    const out = await prepareUploadImage(
      await png(1584, 672),
      'image/png',
      'cover',
    );
    expect(out.warnings).toEqual([]);
  });

  it('caps the longest edge at 3840px', async () => {
    const out = await prepareUploadImage(
      await png(5000, 2000),
      'image/png',
      'cover',
    );
    expect(out.width).toBe(3840);
    expect(out.height).toBe(1536);
  });

  it('applies EXIF orientation to the stored size', async () => {
    const input = await sharp({
      create: { width: 1400, height: 1000, channels: 3, background: '#fff' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await prepareUploadImage(input, 'image/jpeg', 'general');
    expect(out.width).toBe(1000);
    expect(out.height).toBe(1400);
  });
});
