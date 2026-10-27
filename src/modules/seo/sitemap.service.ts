import { Injectable, Optional } from '@nestjs/common';
import { publicVenueWhere } from '../../common/utils/venue-visibility.util';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LocalLandingService } from './local-landing.service';
import { isPosterUrl } from '../posts/video-processing';

/** Venue-owner landing pages under /partners. Keep in sync with PARTNER_TOPIC_SLUGS in the web app. */
export const PARTNER_TOPIC_PATHS = [
  '/partners/pricing',
  '/partners/football',
  '/partners/padel',
  '/partners/gaming',
  '/partners/vs-whatsapp',
];

export function isIndexablePost(text: string, mediaCount: number): boolean {
  if (mediaCount > 0) return true;
  const letters = text.replace(/\s+/g, ' ').trim().slice(0, 150).replace(/[#@]\S+/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  return letters.length >= 12;
}

/** The language a post is canonical in; must match contentLang in the web app's post-detail page. */
export function postContentLang(text: string): 'ar' | 'en' {
  return /\p{Script=Arabic}/u.test(text) || !/\p{L}/u.test(text) ? 'ar' : 'en';
}

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

@Injectable()
export class SitemapService {
  private readonly siteUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    @Optional() private readonly landingPages?: LocalLandingService,
  ) {
    this.siteUrl = (config.get<string>('SITE_URL') || 'https://matchena.com').replace(/\/$/, '');
  }

  private localizedEntry(path: string, lastmod?: Date | null, images: string[] = [], extra = ''): string {
    const ar = `${this.siteUrl}/ar${path}`;
    const en = `${this.siteUrl}/en${path}`;
    return [ar, en].map((loc, index) => `
  <url>
    <loc>${escapeXml(loc)}</loc>
    ${lastmod ? `<lastmod>${lastmod.toISOString()}</lastmod>` : ''}
    <xhtml:link rel="alternate" hreflang="ar-EG" href="${escapeXml(ar)}"/>
    <xhtml:link rel="alternate" hreflang="en" href="${escapeXml(en)}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(ar)}"/>
    ${images.map((image) => `<image:image><image:loc>${escapeXml(new URL(image, this.siteUrl).toString())}</image:loc></image:image>`).join('')}${extra}
  </url>`).join('');
  }

  /** One URL without an hreflang pair, for pages whose content has a single language (user posts). */
  private singleEntry(path: string, lastmod?: Date | null, images: string[] = [], extra = ''): string {
    return `
  <url>
    <loc>${escapeXml(`${this.siteUrl}${path}`)}</loc>
    ${lastmod ? `<lastmod>${lastmod.toISOString()}</lastmod>` : ''}
    ${images.map((image) => `<image:image><image:loc>${escapeXml(new URL(image, this.siteUrl).toString())}</image:loc></image:image>`).join('')}${extra}
  </url>`;
  }

  private urlset(entries: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">${entries}
</urlset>`;
  }

  private readonly publicPostWhere = {
    status: 'active' as const,
    visibility: 'public',
    autoHidden: false,
    flagged: false,
  };
  private static readonly MAX_POSTS = 5000;
  private static readonly MIN_HASHTAG_POSTS = 3;

  async index(): Promise<string> {
    const [venue, blog, post, hashtag, hashtagCount, sport] = await Promise.all([
      this.prisma.venue.aggregate({ where: publicVenueWhere(), _max: { updatedAt: true } }),
      this.prisma.blogPost.aggregate({ where: { status: 'published' }, _max: { updatedAt: true } }),
      this.prisma.post.aggregate({ where: this.publicPostWhere, _max: { updatedAt: true } }),
      this.prisma.hashtag.aggregate({ where: { postCount: { gte: SitemapService.MIN_HASHTAG_POSTS } }, _max: { updatedAt: true } }),
      this.prisma.hashtag.count({ where: { postCount: { gte: SitemapService.MIN_HASHTAG_POSTS } } }),
      this.prisma.sportCategory.aggregate({ _max: { createdAt: true } }),
    ]);
    const entries: [string, Date | null | undefined][] = [
      ['static', null],
      ['sports', sport._max.createdAt],
      ['venues', venue._max.updatedAt],
      ['landings', venue._max.updatedAt],
      ['blog', blog._max.updatedAt],
      ['posts', post._max.updatedAt],
    ];
    if (hashtagCount > 0) entries.push(['hashtags', hashtag._max.updatedAt]);
    const items = entries
      .map(([name, date]) =>
        `  <sitemap><loc>${this.siteUrl}/sitemaps/${name}.xml</loc>${date ? `<lastmod>${date.toISOString()}</lastmod>` : ''}</sitemap>`,
      )
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items}
</sitemapindex>`;
  }

  async venues(): Promise<string> {
    const venues = await this.prisma.venue.findMany({
      where: publicVenueWhere(),
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

  async sports(): Promise<string> {
    // The sport hub is noindex while no public venue offers the sport; listing it here would contradict that.
    const sports = await this.prisma.sportCategory.findMany({
      where: { venueSports: { some: { venue: publicVenueWhere() } } },
      select: { slug: true, createdAt: true },
    });
    return this.urlset(
      sports.map((sport) => this.localizedEntry(`/sports/${encodeURIComponent(sport.slug)}`, sport.createdAt)).join(''),
    );
  }

  async landings(): Promise<string> {
    const entries = (await this.landingPages?.sitemapEntries()) ?? [];
    return this.urlset(entries.map((entry) => this.localizedEntry(entry.path, entry.lastmod, entry.images)).join(''));
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

  async posts(): Promise<string> {
    const posts = await this.prisma.post.findMany({
      where: this.publicPostWhere,
      select: {
        id: true,
        slug: true,
        updatedAt: true,
        createdAt: true,
        text: true,
        media: {
          select: { type: true, url: true, thumbnailUrl: true, durationSeconds: true },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: SitemapService.MAX_POSTS,
    });
    return this.urlset(
      posts
        .filter((post) => isIndexablePost(post.text, post.media.length))
        .map((post) => {
          const images = post.media.filter((m) => m.type === 'image').map((m) => m.url);
          const videos = post.media
            .filter((m) => m.type === 'video' && isPosterUrl(m.thumbnailUrl, m.url))
            .map((m) => this.videoEntry(post.text, post.createdAt, m))
            .join('');
          return this.singleEntry(
            `/${postContentLang(post.text)}/community/post/${encodeURIComponent(`${post.slug}-${post.id}`)}`,
            post.updatedAt,
            images,
            videos,
          );
        })
        .join(''),
    );
  }

  /** Google drops a <video:video> without a real thumbnail, so callers pass only media with a poster. */
  private videoEntry(
    text: string,
    createdAt: Date,
    media: { url: string; thumbnailUrl: string; durationSeconds: number | null },
  ): string {
    const caption = text.replace(/\s+/g, ' ').trim();
    const title = caption.slice(0, 100) || 'Matchena community video';
    const description = caption.slice(0, 2048) || 'A sports video shared by a player on Matchena.';
    const abs = (url: string) => escapeXml(new URL(url, this.siteUrl).toString());
    const duration = media.durationSeconds && media.durationSeconds > 0
      ? `<video:duration>${Math.min(28800, Math.round(media.durationSeconds))}</video:duration>`
      : '';
    return `<video:video><video:thumbnail_loc>${abs(media.thumbnailUrl)}</video:thumbnail_loc><video:title>${escapeXml(title)}</video:title><video:description>${escapeXml(description)}</video:description><video:content_loc>${abs(media.url)}</video:content_loc>${duration}<video:publication_date>${createdAt.toISOString()}</video:publication_date><video:family_friendly>yes</video:family_friendly></video:video>`;
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
      ...PARTNER_TOPIC_PATHS,
      '/contact', '/help', '/terms', '/privacy', '/refund-policy',
    ];
    return this.urlset(paths.map((path) => this.localizedEntry(path)).join(''));
  }
}
