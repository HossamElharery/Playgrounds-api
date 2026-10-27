import { LlmsService } from './llms.service';
import { SitemapService } from './sitemap.service';

const config = { get: () => 'https://matchena.com' } as never;
const date = new Date('2026-09-20T00:00:00Z');

let lastSportWhere: unknown;

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
      findMany: async () => [
        { id: 'abc', slug: 'hello', updatedAt: date, createdAt: date, text: 'مباراة بادل الليلة في مدينة نصر', media: [] },
        { id: 'thin', slug: 'heart', updatedAt: date, createdAt: date, text: '❤️', media: [] },
        {
          id: 'vid', slug: 'dunk', updatedAt: date, createdAt: date, text: 'Dunk & finish',
          media: [{ type: 'video', url: 'https://api.matchena.com/uploads/posts/v.mp4', thumbnailUrl: 'https://api.matchena.com/uploads/posts/thumbnails/v-poster.jpg', durationSeconds: 30 }],
        },
        {
          id: 'noposter', slug: 'clip', updatedAt: date, createdAt: date, text: '',
          media: [{ type: 'video', url: 'https://api.matchena.com/uploads/posts/n.mp4', thumbnailUrl: 'https://api.matchena.com/uploads/posts/n.mp4', durationSeconds: null }],
        },
      ],
    },
    hashtag: {
      aggregate: async () => ({ _max: { updatedAt: date } }),
      count: async () => 1,
      findMany: async () => [{ tag: 'كورة', updatedAt: date }],
    },
    sportCategory: {
      aggregate: async () => ({ _max: { createdAt: date } }),
      findMany: async (args?: { where?: unknown }) => {
        lastSportWhere = args?.where;
        return [{ slug: 'padel', nameEn: 'Padel', nameAr: 'بادل', createdAt: date }];
      },
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

  it('keeps emoji-only posts out of the posts sitemap and never invents a static lastmod', async () => {
    const posts = await svc.posts();
    expect(posts).toContain('hello-abc');
    expect(posts).not.toContain('heart-thin');
    const index = await svc.index();
    expect(index).toMatch(/sitemaps\/static\.xml<\/loc><\/sitemap>/);
  });

  it('lists videos with a poster as <video:video> and skips videos without one', async () => {
    const xml = await svc.posts();
    expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
    expect(xml).toContain('<video:thumbnail_loc>https://api.matchena.com/uploads/posts/thumbnails/v-poster.jpg</video:thumbnail_loc>');
    expect(xml).toContain('<video:content_loc>https://api.matchena.com/uploads/posts/v.mp4</video:content_loc>');
    expect(xml).toContain('<video:title>Dunk &amp; finish</video:title>');
    expect(xml).toContain('<video:duration>30</video:duration>');
    expect(xml).toContain('clip-noposter');
    expect(xml).not.toContain('n.mp4</video:content_loc>');
  });

  it('lists only sports that a public venue offers', async () => {
    expect(await svc.sports()).toContain('/ar/sports/padel');
    expect(lastSportWhere).toEqual({ venueSports: { some: { venue: { status: 'active', ownerListingEnabled: true, adminHidden: false } } } });
  });

  it('posts and hashtags use the frontend url shapes', async () => {
    expect(await svc.posts()).toContain('/community/post/hello-abc');
    expect(await svc.hashtags()).toContain(`/community/hashtag/${encodeURIComponent('كورة')}`);
  });

  it('landings list only the local pages the landing engine marks indexable', async () => {
    const landingPages = {
      sitemapEntries: async () => [{ path: '/egypt/cairo/nasr-city', lastmod: date, images: ['/p.jpg'] }],
    };
    const xml = await new SitemapService(prismaMock(), config, landingPages as never).landings();
    expect(xml).toContain('https://matchena.com/ar/egypt/cairo/nasr-city');
    expect(xml).toContain('https://matchena.com/en/egypt/cairo/nasr-city');
    expect(xml).toContain('<image:loc>https://matchena.com/p.jpg</image:loc>');
    expect(xml).not.toContain('explore?');
  });

  it('static sitemap lists the venue-owner landing pages in both languages', () => {
    const xml = svc.staticPages();
    for (const path of ['/partners', '/partners/pricing', '/partners/football', '/partners/padel', '/partners/gaming', '/partners/vs-whatsapp']) {
      expect(xml).toContain(`https://matchena.com/ar${path}</loc>`);
      expect(xml).toContain(`https://matchena.com/en${path}</loc>`);
    }
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
    expect(summary).toContain('/en/partners/pricing');
    const full = await svc.full();
    expect(full).toContain('### Q?');
    expect(full).toContain('Body');
  });
});
