import { LlmsService } from './llms.service';
import { SitemapService } from './sitemap.service';

const config = { get: () => 'https://matchena.com' } as never;
const date = new Date('2026-09-20T00:00:00Z');

function prismaMock() {
  return {
    venue: {
      aggregate: async () => ({ _max: { updatedAt: date } }),
      findMany: async () => [
        {
          slug: 'court-1', nameEn: 'Court One', nameAr: 'ملعب واحد', descriptionEn: '<p>Nice court</p>', address: 'Cairo',
          updatedAt: date, photos: [{ url: '/p.jpg' }],
          governorate: { nameEn: 'Cairo' }, district: { nameEn: 'Nasr City' }, sports: [{ sport: { nameEn: 'Padel' } }],
        },
      ],
      count: async () => 1,
    },
    blogPost: {
      aggregate: async () => ({ _max: { updatedAt: date } }),
      findMany: async () => [
        { slug: 'how-to', titleEn: 'How to', titleAr: 'إزاي', subtitleEn: 'Sub', subtitleAr: 'فرعي', contentEn: '<p>Body</p>', contentAr: '<p>نص</p>', updatedAt: date, coverImageUrl: null, publishedAt: date },
      ],
    },
    post: {
      aggregate: async () => ({ _max: { updatedAt: date } }),
      findMany: async () => [{ id: 'abc', slug: 'hello', updatedAt: date }],
    },
    hashtag: {
      aggregate: async () => ({ _max: { updatedAt: date } }),
      findMany: async () => [{ tag: 'كورة', updatedAt: date }],
    },
    sportCategory: {
      aggregate: async () => ({ _max: { createdAt: date } }),
      findMany: async () => [{ slug: 'padel', nameEn: 'Padel', nameAr: 'بادل', createdAt: date }],
    },
    governorate: { findMany: async () => [{ slug: 'cairo' }] },
    district: { findMany: async () => [{ slug: 'nasr-city' }] },
    faqEntry: { findMany: async () => [{ questionEn: 'Q?', questionAr: 'س؟', answerEn: 'A', answerAr: 'ج' }] },
  } as never;
}

describe('SitemapService', () => {
  const svc = new SitemapService(prismaMock(), config);

  it('index lists every child sitemap', async () => {
    const xml = await svc.index();
    for (const name of ['static', 'sports', 'venues', 'landings', 'blog', 'posts', 'hashtags']) {
      expect(xml).toContain(`/sitemaps/${name}.xml`);
    }
  });

  it('blog sitemap has ar/en urls with hreflang', async () => {
    const xml = await svc.blog();
    expect(xml).toContain('https://matchena.com/ar/blog/how-to');
    expect(xml).toContain('https://matchena.com/en/blog/how-to');
    expect(xml).toContain('hreflang="x-default"');
  });

  it('posts and hashtags use the frontend url shapes', async () => {
    expect(await svc.posts()).toContain('/community/post/hello-abc');
    expect(await svc.hashtags()).toContain(`/community/hashtag/${encodeURIComponent('كورة')}`);
  });

  it('landings cover governorate, district and sport', async () => {
    const xml = await svc.landings();
    expect(xml).toContain('explore?governorate=cairo');
    expect(xml).toContain('explore?district=nasr-city');
    expect(xml).toContain('explore?sport=padel');
  });
});

describe('LlmsService', () => {
  it('builds llms.txt and llms-full.txt from live data', async () => {
    const svc = new LlmsService(prismaMock(), config);
    const summary = await svc.summary();
    expect(summary.startsWith('# Matchena')).toBe(true);
    expect(summary).toContain('/en/blog/how-to');
    expect(summary).toContain('/en/venues/court-1');
    expect(summary).toContain('/en/sports/padel');
    const full = await svc.full();
    expect(full).toContain('### Q?');
    expect(full).toContain('Body');
  });
});
