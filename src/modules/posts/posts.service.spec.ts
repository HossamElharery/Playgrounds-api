import { PostsService } from './posts.service';
import { slugifyPost, parsePermalinkParam } from './posts-slug.util';
import { containsBlockedLanguage, extractHashtags } from './profanity.util';

describe('posts helpers', () => {
  it('slugifies arabic and english text', () => {
    expect(slugifyPost('Night game at El Nozha padel club extra words')).toBe(
      'night-game-at-el-nozha-padel',
    );
    expect(slugifyPost('ملعب النزهة')).toMatch(/[a-z-]+/);
  });

  it('parses permalink ids from slug-id urls', () => {
    const id = 'b0c6ee30-43c7-4d7c-b21b-2ba2768f1837';
    expect(parsePermalinkParam(`malaab-el-nozha-${id}`).id).toBe(id);
  });

  it('extracts hashtags and flags blocked language', () => {
    expect(extractHashtags('Love #Padel and #Football_5 tonight')).toEqual([
      'padel',
      'football_5',
    ]);
    expect(containsBlockedLanguage('this is a scam')).toBe(true);
    expect(containsBlockedLanguage('friendly padel night')).toBe(false);
  });
});

describe('PostsService.share', () => {
  const prisma = {
    postShare: { findFirst: jest.fn(), create: jest.fn() },
    post: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  };
  const analytics = { emit: jest.fn() };
  let service: PostsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
    prisma.post.findUnique.mockResolvedValue({
      id: 'p1',
      status: 'active',
      autoHidden: false,
      shareCount: 1,
    });
    prisma.post.findUniqueOrThrow.mockResolvedValue({ id: 'p1', shareCount: 1 });
    service = new PostsService(
      prisma as never,
      { create: jest.fn() } as never,
      analytics as never,
      { bumpTags: jest.fn() } as never,
    );
  });

  it('counts a share once per user', async () => {
    prisma.postShare.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ postId: 'p1', userId: 'u1' });
    prisma.post.update.mockResolvedValue({ id: 'p1', shareCount: 1 });

    const first = await service.share('u1', 'p1');
    const second = await service.share('u1', 'p1');

    expect(prisma.postShare.create).toHaveBeenCalledTimes(1);
    expect(prisma.post.update).toHaveBeenCalledTimes(1);
    expect(first.shareCount).toBe(1);
    expect(second.shareCount).toBe(1);
  });
});

describe('PostsService.like', () => {
  const prisma = {
    postLike: { count: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    post: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  };
  const analytics = { emit: jest.fn() };
  let service: PostsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
    prisma.post.findUnique.mockResolvedValue({
      id: 'p1',
      status: 'active',
      autoHidden: false,
      likeCount: 1,
    });
    prisma.postLike.count.mockResolvedValue(0);
    prisma.post.findUniqueOrThrow.mockResolvedValue({ id: 'p1', likeCount: 1 });
    service = new PostsService(
      prisma as never,
      { create: jest.fn() } as never,
      analytics as never,
      { bumpTags: jest.fn() } as never,
    );
  });

  it('is idempotent when the same user likes twice', async () => {
    prisma.postLike.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ postId: 'p1', userId: 'u1' });
    prisma.post.update.mockResolvedValue({ id: 'p1', likeCount: 1 });

    const first = await service.like('u1', 'p1');
    const second = await service.like('u1', 'p1');

    expect(prisma.postLike.create).toHaveBeenCalledTimes(1);
    expect(prisma.post.update).toHaveBeenCalledTimes(1);
    expect(first.liked).toBe(true);
    expect(second.liked).toBe(true);
    expect(analytics.emit).toHaveBeenCalledWith('post_liked', 'u1', { postId: 'p1' });
  });
});

describe('PostsService IndexNow ping', () => {
  const indexNow = { notifyUrls: jest.fn().mockResolvedValue(undefined) };
  const service = new PostsService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    indexNow as never,
  );
  const ping = (post: Record<string, unknown>, media = 1) =>
    (service as unknown as { pingSearchEngines: (p: unknown, m: number) => void }).pingSearchEngines(
      { id: 'p1', slug: 'night-padel', text: 'ماتش بادل', status: 'active', visibility: 'public', autoHidden: false, flagged: false, ...post },
      media,
    );

  beforeEach(() => {
    indexNow.notifyUrls.mockReset();
    indexNow.notifyUrls.mockResolvedValue(undefined);
  });

  it('sends a new public post at its canonical URL', () => {
    ping({});
    ping({ text: 'Friday night padel at the club' });
    expect(indexNow.notifyUrls.mock.calls).toEqual([
      [['/ar/community/post/night-padel-p1']],
      [['/en/community/post/night-padel-p1']],
    ]);
  });

  it('skips posts that are flagged, hidden, private or too thin to index', () => {
    ping({ flagged: true });
    ping({ autoHidden: true });
    ping({ visibility: 'followers' });
    ping({ text: 'ok' }, 0);
    expect(indexNow.notifyUrls).not.toHaveBeenCalled();
  });
});
