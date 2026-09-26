// The backend uses legacy CommonJS resolution; sharp's runtime export is callable.
const sharp: typeof import('sharp').default = require('sharp');

/** A 3× thumbnail for the dashboard's 64px media cell. Originals stay untouched. */
export async function createPostThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(192, 192, { fit: 'cover', withoutEnlargement: true })
    .webp({ quality: 72, effort: 4 })
    .toBuffer();
}
