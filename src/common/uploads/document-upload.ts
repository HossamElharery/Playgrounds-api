import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/png']);

export const DOCUMENT_UPLOAD_OPTIONS: MulterOptions = {
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      cb(
        new BadRequestException('Documents must be PDF, JPEG, or PNG'),
        false,
      );
      return;
    }
    cb(null, true);
  },
};
