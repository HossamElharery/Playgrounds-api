import { ContentController, readingMinutes } from './content.controller';

describe('public blog list summary mode', () => {
  const post = { id: 'p1', slug: 'guide', contentAr: '<p>' + 'كلمة '.repeat(400) + '</p>', contentEn: '<p>short</p>', titleEn: 'Guide' };
  const content = { listBlogPosts: async () => ({ items: [post], pagination: { currentPage: 1 } }) };
  const controller = new ContentController(content as never);

  it('estimates reading time like the web app', () => {
    expect(readingMinutes(post.contentAr)).toBe(2);
    expect(readingMinutes(null)).toBe(1);
  });

  it('drops article HTML and sends minutes only when asked', async () => {
    const summary = await controller.listBlog({ page: 1, perPage: 12, summary: 'true' } as never);
    expect(summary.result[0]).not.toHaveProperty('contentAr');
    expect(summary.result[0]).toMatchObject({ slug: 'guide', readingMinutesAr: 2, readingMinutesEn: 1 });
    const full = await controller.listBlog({ page: 1, perPage: 12 } as never);
    expect(full.result[0]).toHaveProperty('contentAr');
  });
});
