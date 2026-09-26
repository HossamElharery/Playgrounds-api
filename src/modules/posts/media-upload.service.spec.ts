import { BadRequestException } from '@nestjs/common';
import { MediaUploadService } from './media-upload.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
const sharp: typeof import('sharp').default = require('sharp');

describe('MediaUploadService image previews', () => {
  const prisma = { mediaAsset: { findFirst: jest.fn(), update: jest.fn() } };
  const storage = { uploadBuffer: jest.fn() };
  let service: MediaUploadService;
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.mediaAsset.findFirst.mockResolvedValue({
      id: 'asset',
      type: 'image',
    });
    prisma.mediaAsset.update.mockImplementation(({ data }) =>
      Promise.resolve(data),
    );
    storage.uploadBuffer
      .mockResolvedValueOnce({
        key: 'posts/original.png',
        url: '/uploads/posts/original.png',
      })
      .mockResolvedValueOnce({
        key: 'posts/thumbnails/preview.webp',
        url: '/uploads/posts/thumbnails/preview.webp',
      });
    service = new MediaUploadService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
    );
  });
  it('stores a real thumbnail separately and retains the original full-size URL', async () => {
    const buffer = await sharp({
      create: { width: 427, height: 427, channels: 3, background: '#177544' },
    })
      .png()
      .toBuffer();
    const result = await service.receiveFile('user', 'asset', {
      buffer,
      mimetype: 'image/png',
      originalname: 'photo.png',
      size: buffer.length,
    });
    expect(result.url).toBe('/uploads/posts/original.png');
    expect(result.thumbnailUrl).toBe('/uploads/posts/thumbnails/preview.webp');
    const [thumbnail, name, mime, prefix] = storage.uploadBuffer.mock.calls[1];
    expect([name, mime, prefix]).toEqual([
      'preview.webp',
      'image/webp',
      'posts/thumbnails',
    ]);
    expect(await sharp(thumbnail).metadata()).toMatchObject({
      width: 192,
      height: 192,
      format: 'webp',
    });
  });
  it('validates image bytes before writing files', async () => {
    const buffer = Buffer.from('invalid');
    await expect(
      service.receiveFile('user', 'asset', {
        buffer,
        mimetype: 'image/png',
        originalname: 'photo.png',
        size: buffer.length,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
  });
});
