import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { MediaUploadController } from './media-upload.controller';
import { MediaUploadService } from './media-upload.service';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const ASSET = '9d4c2b1a-7e6f-4a3b-8c2d-1e0f9a8b7c6d';

/** A real H.264/AAC clip, `seconds` long. */
function clip(seconds: number, size = '1280x720', rate = 30): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'chunk-spec-'));
  const file = join(dir, 'clip.mp4');
  execFileSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${rate}`, '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file],
    { stdio: 'ignore' },
  );
  const bytes = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

(hasFfmpeg ? describe : describe.skip)('chunked video upload over HTTP', () => {
  jest.setTimeout(120_000);
  let app: INestApplication;
  let root: string;
  const row: Record<string, unknown> = {};

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'chunk-store-'));
    const prisma = {
      mediaAsset: {
        findFirst: jest.fn(({ where }) =>
          Promise.resolve(where.id === row.id && (!where.status || where.status === row.status) ? row : null),
        ),
        update: jest.fn(({ data }) => Promise.resolve(Object.assign(row, data))),
      },
    };
    const storage = {
      urlFor: (key: string) => `/uploads/${key}`,
      uploadFile: async (path: string, name: string, _mime: string, prefix: string) => {
        const key = `${prefix}/${Date.now()}-${name}`;
        await mkdir(dirname(join(root, key)), { recursive: true });
        await copyFile(path, join(root, key));
        return { key, url: `/uploads/${key}` };
      },
      uploadBuffer: async () => ({ key: 'posts/thumbnails/p.jpg', url: '/uploads/posts/thumbnails/p.jpg' }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [MediaUploadController],
      providers: [
        MediaUploadService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) => {
          ctx.switchToHttp().getRequest().user = { id: 'user' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const key of Object.keys(row)) delete row[key];
    Object.assign(row, {
      id: ASSET, userId: 'user', type: 'video', status: 'pending', key: 'posts/raw.mp4', mimeType: 'video/mp4', durationSeconds: 10,
    });
    rmSync(join(tmpdir(), 'matchena-uploads', `${ASSET}.part`), { force: true });
  });

  async function send(bytes: Buffer, chunk = 4 * 1024 * 1024) {
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      const res = await request(app.getHttpServer())
        .post(`/media/uploads/${ASSET}/chunks?offset=${offset}`)
        .attach('chunk', bytes.subarray(offset, offset + chunk), 'chunk');
      expect(res.status).toBe(201);
      expect(res.body.received).toBe(Math.min(bytes.length, offset + chunk));
    }
    return request(app.getHttpServer()).post(`/media/uploads/${ASSET}/chunks/finish`);
  }

  it('reassembles a multi-chunk clip byte for byte and records its real length', async () => {
    const bytes = clip(8);
    const slice = 96 * 1024;
    expect(bytes.length).toBeGreaterThan(3 * slice);
    // A repeated first chunk (lost response) must not be appended twice.
    await request(app.getHttpServer())
      .post(`/media/uploads/${ASSET}/chunks?offset=0`)
      .attach('chunk', bytes.subarray(0, slice), 'chunk');
    const status = await request(app.getHttpServer()).get(`/media/uploads/${ASSET}/chunks`);
    expect(status.body).toEqual({ received: slice });
    const done = await send(bytes, slice);
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ status: 'ready', width: 1280, height: 720, durationSeconds: 8 });
    const stored = readFileSync(join(root, (row.key as string)));
    // The stored copy is the faststart remux: same size class, moov ahead of the media data.
    expect(stored.indexOf('moov')).toBeLessThan(stored.indexOf('mdat'));
    expect(Math.abs(stored.length - bytes.length)).toBeLessThan(64 * 1024);
  }, 120_000);

  it('refuses a clip over 90 seconds even when the app claimed it was short', async () => {
    const res = await send(clip(95, '160x120', 5));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Video must be 90 seconds or shorter');
    expect(row.status).toBe('pending');
  }, 120_000);

  it('refuses a chunk sent at the wrong offset and reports what it has', async () => {
    const res = await request(app.getHttpServer())
      .post(`/media/uploads/${ASSET}/chunks?offset=10`)
      .attach('chunk', Buffer.from('abc'), 'chunk');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ message: 'Upload offset mismatch', received: 0 });
  });
});
