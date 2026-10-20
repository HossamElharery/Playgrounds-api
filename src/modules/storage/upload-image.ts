import { UnprocessableEntityException } from '@nestjs/common';
const sharp: typeof import('sharp').default = require('sharp');

export type UploadPurpose = 'cover' | 'inline' | 'general';
export const UPLOAD_PURPOSE_RULES: Record<
  UploadPurpose,
  { minWidth: number; recommendedWidth: number; recommendedHeight?: number }
> = {
  // Matchena blog cover ratio: 1584×672 (2.357:1). Keep 1200px as the
  // hard minimum, while treating the CMS's standard upload size as sharp.
  cover: { minWidth: 1200, recommendedWidth: 1584, recommendedHeight: 672 },
  inline: { minWidth: 640, recommendedWidth: 1200 },
  general: { minWidth: 0, recommendedWidth: 0 },
};
export const MAX_ORIGINAL_EDGE = 3840;

export function parseUploadPurpose(value: unknown): UploadPurpose {
  return value === 'cover' || value === 'inline' ? value : 'general';
}

export interface PreparedImage {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  warnings: string[];
}

export async function prepareUploadImage(
  input: Buffer,
  mimeType: string,
  purpose: UploadPurpose,
): Promise<PreparedImage> {
  let meta: import('sharp').Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 80_000_000 }).metadata();
  } catch {
    throw new UnprocessableEntityException('The file is not a readable image');
  }
  const rotated = (meta.orientation ?? 1) >= 5; // 5-8 swap width and height
  const srcWidth = (rotated ? meta.height : meta.width) ?? 0;
  const srcHeight = (rotated ? meta.width : meta.height) ?? 0;
  if (!srcWidth || !srcHeight)
    throw new UnprocessableEntityException('The file is not a readable image');

  const rules = UPLOAD_PURPOSE_RULES[purpose];
  const recommendedSize = rules.recommendedHeight
    ? `${rules.recommendedWidth}×${rules.recommendedHeight}`
    : `${rules.recommendedWidth}px`;
  if (srcWidth < rules.minWidth) {
    throw new UnprocessableEntityException(
      `Image is too small (${srcWidth}px wide). Upload at least ${rules.minWidth}px wide ` +
        `(${recommendedSize} or larger recommended).`,
    );
  }

  const needsResize = Math.max(srcWidth, srcHeight) > MAX_ORIGINAL_EDGE;
  const needsRotate = (meta.orientation ?? 1) > 1;
  let buffer = input;
  let width = srcWidth;
  let height = srcHeight;
  if (needsResize || needsRotate) {
    let pipeline = sharp(input, { limitInputPixels: 80_000_000 }).rotate();
    if (needsResize)
      pipeline = pipeline.resize({
        width: MAX_ORIGINAL_EDGE,
        height: MAX_ORIGINAL_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      });
    pipeline =
      mimeType === 'image/png'
        ? pipeline.png({ compressionLevel: 9 })
        : mimeType === 'image/webp'
          ? pipeline.webp({ quality: 90 })
          : pipeline.jpeg({ quality: 90, mozjpeg: true });
    const out = await pipeline.toBuffer({ resolveWithObject: true });
    buffer = out.data;
    width = out.info.width;
    height = out.info.height;
  }

  const warnings: string[] = [];
  if (width < rules.recommendedWidth) {
    warnings.push(
      `low_resolution: ${width}px wide; ${recommendedSize} or larger recommended for sharp display`,
    );
  }
  return { buffer, mimeType, width, height, warnings };
}
