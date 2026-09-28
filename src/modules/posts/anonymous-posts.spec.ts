import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreatePostDto } from './dto/create-post.dto';
import { PostsService } from './posts.service';

type Row = Parameters<PostsService['toDto']>[0];
const author = {
  id: 'private-user-id',
  name: 'Private Name',
  username: 'private_handle',
  avatarUrl: '/private-avatar.jpg',
};
const post = (isAnonymous = true): Row => ({
  id: 'b0c6ee30-43c7-4d7c-b21b-2ba2768f1837',
  slug: 'friendly-game',
  authorId: author.id,
  author,
  authorKind: 'user',
  isAnonymous,
  text: 'Anyone up for a friendly game? #football',
  hashtags: ['football'],
  mentions: [],
  media: [],
  taggedVenue: null,
  taggedVenueId: null,
  linkedMatch: null,
  linkedMatchId: null,
  visibility: 'public',
  status: 'active',
  autoHidden: false,
  removedReason: null,
  likeCount: 0,
  commentCount: 0,
  shareCount: 0,
  saveCount: 0,
  coinsAwarded: false,
  createdAt: new Date('2026-09-28T09:00:00Z'),
  updatedAt: new Date('2026-09-28T09:00:00Z'),
});
const comment = (id: string, authorData: Row['author'] = author) => ({
  id,
  postId: post().id,
  authorId: authorData.id,
  author: authorData,
  parentCommentId: null,
  text: 'See you there',
  mentions: [],
  status: 'active',
  createdAt: new Date(),
});
const assertMasked = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const field of Object.values(author)) expect(json).not.toContain(field);
};

describe('Anonymous community posts', () => {
  const prisma = {
    userPostingRestriction: { findUnique: jest.fn() },
    post: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    postComment: {
      findMany: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    postLike: { findUnique: jest.fn() },
    postSave: { findUnique: jest.fn() },
    follow: { findUnique: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const notifications = { create: jest.fn() };
  let service: PostsService;
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.post.findUnique.mockResolvedValue(post());
    prisma.post.findMany.mockResolvedValue([post()]);
    prisma.post.count.mockResolvedValue(0);
    prisma.follow.findMany.mockResolvedValue([{ followingId: author.id }]);
    prisma.follow.findUnique.mockResolvedValue({ followingId: author.id });
    prisma.$transaction.mockImplementation(
      (fn: (tx: typeof prisma) => unknown) => fn(prisma),
    );
    prisma.post.create.mockResolvedValue(post());
    prisma.post.update.mockResolvedValue(post());
    service = new PostsService(
      prisma as never,
      notifications as never,
      { emit: jest.fn() } as never,
      { bumpTags: jest.fn() } as never,
    );
  });

  it.each([undefined, 'another-user', author.id])(
    'redacts identity for viewer %s while preserving ownership',
    async (viewer) => {
      const dto = await service.toDto(post(), viewer);
      assertMasked(dto);
      expect(dto).toMatchObject({
        isAnonymous: true,
        authorId: null,
        isOwn: viewer === author.id,
        followingAuthor: false,
      });
      expect(dto.author).toEqual({
        id: null,
        name: 'Anonymous member',
        username: null,
        avatarUrl: null,
      });
      expect(prisma.follow.findUnique).not.toHaveBeenCalled();
    },
  );

  it('preserves named authors, follow state and ownership for existing posts', async () => {
    const dto = await service.toDto(post(false), author.id);
    expect(dto).toMatchObject({
      authorId: author.id,
      author,
      isAnonymous: false,
      isOwn: true,
      followingAuthor: true,
    });
  });

  it('redacts identity in detail, SEO, discovery, hashtag and venue responses', async () => {
    for (const value of await Promise.all([
      service.getByParam(post().id),
      service.getForSeo(post().id),
      service.feed('discover', undefined, 20, { id: 'another-user' }),
      service.listByHashtag('football', undefined, 20),
      service.listByVenue('venue-id', undefined, 20),
    ]))
      assertMasked(value);
  });

  it('excludes anonymous posts from other users’ profile listings and the following feed', async () => {
    await service.listByAuthor(author.id, undefined, 20, {
      id: 'another-user',
      roles: ['admin'],
    });
    expect(prisma.post.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isAnonymous: false }),
      }),
    );
    await service.feed('following', undefined, 20, { id: 'another-user' });
    expect(prisma.post.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isAnonymous: false }),
      }),
    );
    await service.listByAuthor(author.id, undefined, 20, { id: author.id });
    expect(
      prisma.post.findMany.mock.calls.at(-1)![0].where.isAnonymous,
    ).toBeUndefined();
  });

  it('persists the private owner but redacts the create response', async () => {
    const dto = await service.create(
      author.id,
      { text: 'Hello team', isAnonymous: true },
      false,
    );
    expect(prisma.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authorId: author.id,
          isAnonymous: true,
          authorKind: 'user',
        }),
      }),
    );
    expect(dto.isOwn).toBe(true);
    assertMasked(dto);
  });

  it('defaults new posts to named when the option is omitted', async () => {
    await service.create(author.id, { text: 'Hello team' }, false);
    expect(prisma.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isAnonymous: false }),
      }),
    );
  });

  it.each([
    { linkedMatchId: 'match-id' },
    { authorKind: 'official' as const },
    { authorKind: 'venue' as const },
  ])('rejects identifying anonymous combinations: %o', async (extra) => {
    await expect(
      service.create(
        author.id,
        { text: 'Hello', isAnonymous: true, ...extra },
        true,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it('does not expose a linked match even if an inconsistent legacy row exists', async () => {
    const dto = await service.toDto({
      ...post(),
      linkedMatchId: 'secret-match',
      linkedMatch: {
        id: 'secret-match',
        sportId: 'football',
        dateTime: new Date(),
      },
    });
    expect(dto.linkedMatchId).toBeNull();
    expect(dto.linkedMatch).toBeNull();
  });

  it('masks the author’s comments and nested replies, leaving other commenters named', async () => {
    const other = {
      ...author,
      id: 'other',
      name: 'Other member',
      username: null,
      avatarUrl: null,
    };
    prisma.postComment.findMany.mockResolvedValue([
      { ...comment('root', other), replies: [comment('reply')] },
      { ...comment('own-root'), replies: [] },
    ]);
    const dto = await service.comments(post().id);
    assertMasked(dto);
    expect(dto.items[0].author.name).toBe('Other member');
    expect(dto.items[0].replies[0]).toMatchObject({
      isAnonymous: true,
      authorId: null,
    });
    expect(dto.items[1]).toMatchObject({ isAnonymous: true, authorId: null });
  });

  it('masks the immediate response when the anonymous author adds a comment', async () => {
    prisma.postComment.create.mockResolvedValue({
      ...comment('new'),
      replies: [],
    });
    const dto = await service.addComment(author.id, post().id, {
      text: 'See you there',
    });
    assertMasked(dto);
    expect(dto.isAnonymous).toBe(true);
  });

  it('allows only the real owner to edit/delete and preserves anonymity on edits', async () => {
    await expect(
      service.updateText('stranger', post().id, 'Edited'),
    ).rejects.toThrow(ForbiddenException);
    await expect(service.removeOwn('stranger', post().id)).rejects.toThrow(
      ForbiddenException,
    );
    const dto = await service.updateText(author.id, post().id, 'Edited');
    assertMasked(dto);
    expect(dto.isOwn).toBe(true);
    expect(prisma.post.update.mock.calls.at(-1)![0].data).not.toHaveProperty(
      'isAnonymous',
    );
    await expect(service.removeOwn(author.id, post().id)).resolves.toEqual({
      ok: true,
    });
  });

  it('validates anonymity as an actual boolean, not a truthy string', async () => {
    for (const value of ['true', 'false', 1, {}]) {
      const dto = plainToInstance(
        CreatePostDto,
        { text: 'Hello', isAnonymous: value },
        { enableImplicitConversion: true },
      );
      expect(
        (await validate(dto)).some((e) => e.property === 'isAnonymous'),
      ).toBe(true);
    }
    for (const value of [undefined, true, false]) {
      expect(
        await validate(
          Object.assign(new CreatePostDto(), {
            text: 'Hello',
            isAnonymous: value,
          }),
        ),
      ).toHaveLength(0);
    }
  });
});
