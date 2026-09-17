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

  private localizedEntry(path: string, lastmod?: Date, images: string[] = []): string {
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

  async index(): Promise<string> {
    const latest = await this.prisma.venue.aggregate({
      where: { status: 'active' },
      _max: { updatedAt: true },
    });
    const lastmod = (latest._max.updatedAt || new Date()).toISOString();
    return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${this.siteUrl}/sitemaps/venues.xml</loc><lastmod>${lastmod}</lastmod></sitemap>
  <sitemap><loc>${this.siteUrl}/sitemaps/landings.xml</loc><lastmod>${lastmod}</lastmod></sitemap>
  <sitemap><loc>${this.siteUrl}/sitemaps/static.xml</loc><lastmod>${lastmod}</lastmod></sitemap>
  <sitemap><loc>${this.siteUrl}/sitemaps/posts.xml</loc><lastmod>${lastmod}</lastmod></sitemap>
  <sitemap><loc>${this.siteUrl}/sitemaps/hashtags.xml</loc><lastmod>${lastmod}</lastmod></sitemap>
</sitemapindex>`;
  }

  async venues(): Promise<string> {
    const venues = await this.prisma.venue.findMany({
      where: { status: 'active' },
      select: {
        slug: true,
        updatedAt: true,
        photos: { orderBy: { position: 'asc' }, select: { url: true } },
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

  async landings(): Promise<string> {
    const [districts, sports] = await Promise.all([
      this.prisma.district.findMany({
        where: { slug: { not: null }, venues: { some: { status: 'active' } } },
        select: { slug: true },
      }),
      this.prisma.sportCategory.findMany({
        where: { venueSports: { some: { venue: { status: 'active' } } } },
        select: { slug: true },
      }),
    ]);
    const districtEntries = districts
      .filter((district): district is { slug: string } => Boolean(district.slug))
      .map((district) =>
        this.localizedEntry(`/explore?district=${encodeURIComponent(district.slug)}`),
      );
    const sportEntries = sports.map((sport) =>
      this.localizedEntry(`/explore?sport=${encodeURIComponent(sport.slug)}`),
    );
    return this.urlset([...districtEntries, ...sportEntries].join(''));
  }

  staticPages(): string {
    const paths = ['', '/about', '/partners', '/how-it-works', '/contact', '/help', '/terms', '/privacy', '/refund-policy', '/community'];
    return this.urlset(paths.map((path) => this.localizedEntry(path)).join(''));
  }

  async posts(): Promise<string> {
    const rows = await this.prisma.post.findMany({
      where: { status: 'active', autoHidden: false, visibility: 'public' },
      select: { slug: true, id: true, updatedAt: true, media: { orderBy: { order: 'asc' }, take: 1, select: { thumbnailUrl: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 5000,
    });
    return this.urlset(
      rows
        .map((row) =>
          this.localizedEntry(
            `/community/post/${row.slug}-${row.id}`,
            row.updatedAt,
            row.media[0]?.thumbnailUrl ? [row.media[0].thumbnailUrl] : [],
          ),
        )
        .join(''),
    );
  }

  async hashtags(): Promise<string> {
    const tags = await this.prisma.hashtag.findMany({
      where: { postCount: { gt: 0 } },
      select: { tag: true, updatedAt: true },
      orderBy: { trendingScore: 'desc' },
      take: 2000,
    });
    return this.urlset(
      tags.map((row) => this.localizedEntry(`/community/hashtag/${encodeURIComponent(row.tag)}`, row.updatedAt)).join(''),
    );
  }
}
