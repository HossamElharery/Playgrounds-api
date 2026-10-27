import { BadRequestException } from '@nestjs/common';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

describe('MediaUploadService videos', () => {
  const ASSET = '4b8f0d5e-2c3a-4f6e-9a7b-1c2d3e4f5a6b';
  const probe = (durationSeconds: number) => ({
    width: 1080, height: 1920, durationSeconds, videoCodec: 'h264', pixelFormat: 'yuv420p',
    audioCodec: 'aac', fps: 30, bitRate: 3_000_000, rotation: 0,
  });
  let prepareVideo: jest.Mock;
  let hasVideoTools: jest.Mock;
  let Service: typeof MediaUploadService;

  beforeEach(async () => {
    jest.resetModules();
    prepareVideo = jest.fn();
    hasVideoTools = jest.fn().mockResolvedValue(true);
    jest.doMock('./video-processing', () => ({
      ...jest.requireActual('./video-processing'),
      prepareVideo,
      hasVideoTools,
    }));
    ({ MediaUploadService: Service } = await import('./media-upload.service'));
  });
  afterEach(() => jest.dontMock('./video-processing'));

  function setup(asset: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = {
      id: ASSET, type: 'video', status: 'pending', key: 'posts/raw.mov', mimeType: 'video/quicktime', durationSeconds: 12,
      ...asset,
    };
    const prisma = {
      mediaAsset: {
        create: jest.fn(({ data }) => Promise.resolve({ ...row, ...data })),
        findFirst: jest.fn(({ where }) =>
          Promise.resolve(where.status && where.status !== row.status ? null : row),
        ),
        update: jest.fn(({ data }) => Promise.resolve(Object.assign(row, data))),
      },
    };
    const stored: string[] = [];
    const storage = {
      urlFor: jest.fn((key: string) => `/uploads/${key}`),
      uploadFile: jest.fn((path: string) => {
        stored.push(readFileSync(path, 'utf8'));
        return Promise.resolve({ key: 'posts/clip.mov', url: '/uploads/posts/clip.mov' });
      }),
      uploadBuffer: jest.fn().mockResolvedValue({ key: 'posts/thumbnails/p.jpg', url: '/uploads/posts/thumbnails/p.jpg' }),
    };
    const optimizer = { enqueue: jest.fn() };
    const service = new Service(prisma as never, storage as never, optimizer as never);
    return { service, prisma, storage, stored, optimizer, row };
  }

  const fastCopy = (seconds: number) => async (_input: string, _mime: string, dir: string) => {
    const videoPath = join(dir, 'fast.mov');
    writeFileSync(videoPath, 'fast');
    return { videoPath, poster: Buffer.from('jpg'), probe: probe(seconds) };
  };

  it('stores the faststart copy and poster with the measured size and length', async () => {
    prepareVideo.mockImplementation(fastCopy(12.4));
    const { service, storage, stored, optimizer } = setup();
    const result = await service.receiveFile('user', ASSET, {
      buffer: Buffer.from('slow'), mimetype: 'video/quicktime', originalname: 'clip.mov', size: 4,
    });
    expect(stored).toEqual(['fast']);
    expect(storage.uploadBuffer.mock.calls[0].slice(1)).toEqual(['poster.jpg', 'image/jpeg', 'posts/thumbnails']);
    expect(result).toMatchObject({
      thumbnailUrl: '/uploads/posts/thumbnails/p.jpg', status: 'ready', width: 1080, height: 1920, durationSeconds: 12,
    });
    expect(optimizer.enqueue).toHaveBeenCalledWith('/uploads/posts/clip.mov');
  });

  it('rejects a clip longer than 90 seconds by its real length, whatever the app said', async () => {
    prepareVideo.mockImplementation(fastCopy(95));
    const { service, storage } = setup({ durationSeconds: 30 });
    await expect(
      service.receiveFile('user', ASSET, { buffer: Buffer.from('x'), mimetype: 'video/mp4', originalname: 'a.mp4', size: 1 }),
    ).rejects.toThrow('Video must be 90 seconds or shorter');
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects an unreadable file, but keeps uploads working where ffprobe is missing', async () => {
    prepareVideo.mockResolvedValue({ probe: null });
    const first = setup();
    await expect(
      first.service.receiveFile('user', ASSET, { buffer: Buffer.from('x'), mimetype: 'video/mp4', originalname: 'a.mp4', size: 1 }),
    ).rejects.toThrow('This file is not a playable video');
    hasVideoTools.mockResolvedValue(false);
    const second = setup();
    await second.service.receiveFile('user', ASSET, { buffer: Buffer.from('raw'), mimetype: 'video/mp4', originalname: 'a.mp4', size: 3 });
    expect(second.stored).toEqual(['raw']);
  });

  it('offers chunked uploads for videos and keeps the single-request URL for older apps', async () => {
    const { service } = setup();
    const ticket = await service.requestUpload('user', {
      filename: 'clip.mov', mimeType: 'video/quicktime', byteSize: 200 * 1024 * 1024, type: 'video', durationSeconds: 60,
    } as never);
    expect(ticket).toMatchObject({ mode: 'chunked', chunkBytes: 4 * 1024 * 1024 });
    expect(ticket.uploadUrl).toMatch(/\/file$/);
    expect((ticket as { chunkUrl: string }).chunkUrl).toMatch(/\/chunks$/);
  });

  it('assembles chunks in order, accepts a retried chunk, and resumes from what landed', async () => {
    prepareVideo.mockResolvedValue({ probe: probe(40) });
    const { service, stored, row } = setup();
    const part = join(tmpdir(), 'matchena-uploads', `${ASSET}.part`);
    rmSync(part, { force: true });
    expect(await service.receiveChunk('user', ASSET, 0, Buffer.from('abc'))).toEqual({ received: 3 });
    expect(await service.receiveChunk('user', ASSET, 0, Buffer.from('abc'))).toEqual({ received: 3 });
    await expect(service.receiveChunk('user', ASSET, 5, Buffer.from('zz'))).rejects.toThrow('Upload offset mismatch');
    expect(await service.receiveChunk('user', ASSET, 3, Buffer.from('def'))).toEqual({ received: 6 });
    expect(await service.chunkStatus('user', ASSET)).toEqual({ received: 6 });
    const ready = await service.finishChunks('user', ASSET);
    expect(stored).toEqual(['abcdef']);
    expect(ready).toMatchObject({ status: 'ready', durationSeconds: 40 });
    expect(existsSync(part)).toBe(false);
    // A retried finish after a dropped response returns the stored asset.
    expect(await service.finishChunks('user', ASSET)).toBe(row);
    await expect(service.receiveChunk('user', ASSET, 6, Buffer.from('g'))).rejects.toThrow('Unknown upload');
  });

  it('refuses chunks past the size limit and for uploads that are not pending videos', async () => {
    const { service } = setup();
    await expect(service.receiveChunk('user', ASSET, 300 * 1024 * 1024, Buffer.from('a'))).rejects.toThrow('Video is too large');
    await expect(service.receiveChunk('user', ASSET, Number.NaN, Buffer.from('a'))).rejects.toThrow('Invalid chunk');
    const image = setup({ type: 'image' });
    await expect(image.service.receiveChunk('user', ASSET, 0, Buffer.from('a'))).rejects.toThrow('Unknown upload');
  });
});
