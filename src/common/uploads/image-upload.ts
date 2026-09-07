import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const IMAGE_UPLOAD_OPTIONS: MulterOptions = {
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      cb(
        new BadRequestException('Only JPEG, PNG, or WebP images are allowed'),
        false,
      );
      return;
    }
    cb(null, true);
  },
};
