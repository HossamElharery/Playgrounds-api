import { deleteOriginalIfUnused, isOptimizedVideoUrl, optimizeStoredVideo } from './video-optimizer';
import { optimizeVideo } from './video-processing';

jest.mock('./video-processing', () => ({
  ...jest.requireActual('./video-processing'),
  optimizeVideo: jest.fn(),
}));

const OLD = 'https://api.matchena.com/uploads/posts/raw.mp4';
const probe = { width: 768, height: 1344, durationSeconds: 30.24, videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'aac', fps: 30, bitRate: 1_500_000, rotation: 0 };

function setup(updated = 1) {
  const calls: Array<{ model: string; args: any }> = [];
  const model = (name: string) => ({
    count: jest.fn().mockResolvedValue(1),
    updateMany: jest.fn((args) => {
      calls.push({ model: name, args });
      return { count: 'url' in (args.data ?? {}) ? updated : 1 };
    }),
  });
  const prisma = {
    postMedia: model('postMedia'),
    mediaAsset: model('mediaAsset'),
    $transaction: jest.fn((ops) => Promise.all(ops)),
  };
  const storage = {
    keyFromUrl: jest.fn((url: string) => url.split('/uploads/')[1]),
    readObject: jest.fn().mockResolvedValue(Buffer.alloc(1000)),
    uploadBuffer: jest
      .fn()
      .mockResolvedValueOnce({ key: 'posts/videos/new.mp4', url: 'https://api.matchena.com/uploads/posts/videos/new.mp4' })
      .mockResolvedValueOnce({ key: 'posts/thumbnails/p.jpg', url: 'https://api.matchena.com/uploads/posts/thumbnails/p.jpg' }),
    deleteObject: jest.fn().mockResolvedValue(undefined),
    urlFor: jest.fn(),
  };
  return { prisma, storage, calls };
}

describe('optimizeStoredVideo', () => {
  beforeEach(() => {
    (optimizeVideo as jest.Mock).mockResolvedValue({ video: Buffer.alloc(300), poster: Buffer.from('jpg'), probe, transcoded: true });
  });

  it('stores the re-encode under posts/videos and moves every row to it with the real size and a poster', async () => {
    const { prisma, storage, calls } = setup();
    const result = await optimizeStoredVideo(prisma as never, storage as never, OLD, true);
    expect(result).toMatchObject({ outcome: 'optimized', beforeBytes: 1000, afterBytes: 300, originalKey: 'posts/raw.mp4' });
    expect(result.newUrl).toContain('/uploads/posts/videos/new.mp4');
    expect(storage.uploadBuffer.mock.calls[0].slice(1)).toEqual(['video.mp4', 'video/mp4', 'posts/videos']);
    const swap = calls.find((c) => c.model === 'mediaAsset' && c.args.data.url)!;
    expect(swap.args).toEqual({
      where: { url: OLD },
      data: { url: result.newUrl, key: 'posts/videos/new.mp4', mimeType: 'video/mp4', width: 768, height: 1344, durationSeconds: 30 },
    });
    const poster = calls.find((c) => c.model === 'postMedia' && c.args.data.thumbnailUrl)!;
    expect(poster.args.where).toEqual({ url: OLD, thumbnailUrl: { in: [OLD, ''] } });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('reports without writing when apply is false', async () => {
    const { prisma, storage } = setup();
    const result = await optimizeStoredVideo(prisma as never, storage as never, OLD, false);
    expect(result.outcome).toBe('optimized');
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('removes its own copy when another worker already swapped the rows', async () => {
    const { prisma, storage } = setup(0);
    const result = await optimizeStoredVideo(prisma as never, storage as never, OLD, true);
    expect(result.outcome).toBe('superseded');
    expect(storage.deleteObject).toHaveBeenCalledWith('posts/videos/new.mp4');
    expect(storage.deleteObject).toHaveBeenCalledWith('posts/thumbnails/p.jpg');
  });

  it('skips optimized files, foreign URLs and unreadable videos', async () => {
    const { prisma, storage } = setup();
    expect((await optimizeStoredVideo(prisma as never, storage as never, 'https://x/uploads/posts/videos/a.mp4', true)).outcome).toBe('already-optimized');
    expect((await optimizeStoredVideo(prisma as never, storage as never, 'https://cdn.example/a.mp4', true)).outcome).toBe('not-stored-here');
    (optimizeVideo as jest.Mock).mockResolvedValue(null);
    expect((await optimizeStoredVideo(prisma as never, storage as never, OLD, true)).outcome).toBe('unreadable');
    expect(isOptimizedVideoUrl('https://api.matchena.com/uploads/posts/videos/a.mp4')).toBe(true);
  });
});

describe('deleteOriginalIfUnused', () => {
  it('keeps a file that a row still points at', async () => {
    const { prisma, storage } = setup();
    expect(await deleteOriginalIfUnused(prisma as never, storage as never, OLD, 'posts/raw.mp4')).toBe(false);
    prisma.postMedia.count.mockResolvedValue(0);
    prisma.mediaAsset.count.mockResolvedValue(0);
    expect(await deleteOriginalIfUnused(prisma as never, storage as never, OLD, 'posts/raw.mp4')).toBe(true);
    expect(storage.deleteObject).toHaveBeenCalledWith('posts/raw.mp4');
  });
});
