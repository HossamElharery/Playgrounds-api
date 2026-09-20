import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

@Injectable()
export class SitemapService {
  private readonly siteUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.siteUrl = (config.get<string>('SITE_URL') || 'https://matchena.com').replace(/\/$/, '');
  }

  private localizedEntry(path: string, lastmod?: Date | null, images: string[] = []): string {
    const ar = `${this.siteUrl}/ar${path}`;
    const en = `${this.siteUrl}/en${path}`;
    return [ar, en].map((loc, index) => `
  <url>
    <loc>${escapeXml(loc)}</loc>
    ${lastmod ? `<lastmod>${lastmod.toISOString()}</lastmod>` : ''}
    <xhtml:link rel="alternate" hreflang="ar-EG" href="${escapeXml(ar)}"/>
    <xhtml:link rel="alternate" hreflang="en" href="${escapeXml(en)}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(ar)}"/>
    ${images.map((image) => `<image:image><image:loc>${escapeXml(new URL(image, this.siteUrl).toString())}</image:loc></image:image>`).join('')}
  </url>`).join('');
  }

  private urlset(entries: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${entries}
</urlset>`;
  }

  /** Public, indexable community posts (same filter the public feed uses). */
  private readonly publicPostWhere = {
    status: 'active' as const,
    visibility: 'public',
    autoHidden: false,
    flagged: false,
  };
  private static readonly MAX_POSTS = 5000;
  private static readonly MIN_HASHTAG_POSTS = 3;

  async index(): Promise<string> {
    const [venue, blog, post, hashtag, sport] = await Promise.all([
      this.prisma.venue.aggregate({ where: { status: 'active' }, _max: { updatedAt: true } }),
      this.prisma.blogPost.aggregate({ where: { status: 'published' }, _max: { updatedAt: true } }),
      this.prisma.post.aggregate({ where: this.publicPostWhere, _max: { updatedAt: true } }),
      this.prisma.hashtag.aggregate({ _max: { updatedAt: true } }),
      this.prisma.sportCategory.aggregate({ _max: { createdAt: true } }),
    ]);
    const now = new Date();
    const entries: [string, Date | null | undefined][] = [
      ['static', null],
      ['sports', sport._max.createdAt],
      ['venues', venue._max.updatedAt],
      ['landings', venue._max.updatedAt],
      ['blog', blog._max.updatedAt],
      ['posts', post._max.updatedAt],
      ['hashtags', hashtag._max.updatedAt],
    ];
    const items = entries
      .map(([name, date]) =>
        `  <sitemap><loc>${this.siteUrl}/sitemaps/${name}.xml</loc><lastmod>${(date ?? now).toISOString()}</lastmod></sitemap>`,
      )
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items}
</sitemapindex>`;
  }

  async venues(): Promise<string> {
    const venues = await this.prisma.venue.findMany({
      where: { status: 'active' },
      select: {
        slug: true,
        updatedAt: true,
        photos: { orderBy: { position: 'asc' }, take: 5, select: { url: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return this.urlset(
      venues.map((venue) => this.localizedEntry(
        `/venues/${encodeURIComponent(venue.slug)}`,
        venue.updatedAt,
        venue.photos.map((photo) => photo.url),
      )).join(''),
    );
  }

  /** One hub page per sport (`/sports/:slug`). */
  async sports(): Promise<string> {
    const sports = await this.prisma.sportCategory.findMany({ select: { slug: true, createdAt: true } });
    return this.urlset(
      sports.map((sport) => this.localizedEntry(`/sports/${encodeURIComponent(sport.slug)}`, sport.createdAt)).join(''),
    );
  }

  /** Indexable explore landings: governorate, district and sport filters that actually have venues. */
  async landings(): Promise<string> {
    const [governorates, districts, sports] = await Promise.all([
      this.prisma.governorate.findMany({
        where: { slug: { not: null }, venues: { some: { status: 'active' } } },
        select: { slug: true },
      }),
      this.prisma.district.findMany({
        where: { slug: { not: null }, venues: { some: { status: 'active' } } },
        select: { slug: true },
      }),
      this.prisma.sportCategory.findMany({
        where: { venueSports: { some: { venue: { status: 'active' } } } },
        select: { slug: true },
      }),
    ]);
    const entry = (key: string, slug: string | null) =>
      slug ? this.localizedEntry(`/explore?${key}=${encodeURIComponent(slug)}`) : '';
    return this.urlset(
      [
        ...governorates.map((g) => entry('governorate', g.slug)),
        ...districts.map((d) => entry('district', d.slug)),
        ...sports.map((s) => entry('sport', s.slug)),
      ].join(''),
    );
  }

  async blog(): Promise<string> {
    const posts = await this.prisma.blogPost.findMany({
      where: { status: 'published' },
      select: { slug: true, updatedAt: true, coverImageUrl: true },
      orderBy: { updatedAt: 'desc' },
    });
    return this.urlset(
      this.localizedEntry('/blog', posts[0]?.updatedAt) +
        posts
          .map((post) =>
            this.localizedEntry(
              `/blog/${encodeURIComponent(post.slug)}`,
              post.updatedAt,
              post.coverImageUrl ? [post.coverImageUrl] : [],
            ),
          )
          .join(''),
    );
  }

  /** Public community posts. Each post is a single URL; the renderer localises the shell. */
  async posts(): Promise<string> {
    const posts = await this.prisma.post.findMany({
      where: this.publicPostWhere,
      select: { id: true, slug: true, updatedAt: true },
      orderBy: { createdAt: 'desc' },
      take: SitemapService.MAX_POSTS,
    });
    return this.urlset(
      posts
        .map((post) => this.localizedEntry(`/community/post/${encodeURIComponent(`${post.slug}-${post.id}`)}`, post.updatedAt))
        .join(''),
    );
  }

  async hashtags(): Promise<string> {
    const tags = await this.prisma.hashtag.findMany({
      where: { postCount: { gte: SitemapService.MIN_HASHTAG_POSTS } },
      select: { tag: true, updatedAt: true },
      orderBy: { postCount: 'desc' },
      take: 2000,
    });
    return this.urlset(
      tags.map((t) => this.localizedEntry(`/community/hashtag/${encodeURIComponent(t.tag)}`, t.updatedAt)).join(''),
    );
  }

  staticPages(): string {
    const paths = [
      '', '/explore', '/community', '/leaderboards', '/blog', '/about', '/partners', '/how-it-works',
      '/contact', '/help', '/terms', '/privacy', '/refund-policy',
    ];
    return this.urlset(paths.map((path) => this.localizedEntry(path)).join(''));
  }
}
