import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

const stripHtml = (html: string) =>
  html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
// Markdown link text must not contain brackets.
const label = (text: string) => text.replace(/[\[\]]/g, '').trim();

/**
 * Generates /llms.txt (curated index) and /llms-full.txt (readable content) from live data,
 * so new venues, sports, articles and FAQs reach AI crawlers without a deploy.
 * Spec: https://llmstxt.org — H1, blockquote summary, then H2 sections of links.
 */
@Injectable()
export class LlmsService {
  private readonly siteUrl: string;
  private cache = new Map<string, { at: number; body: string }>();
  private static readonly TTL_MS = 10 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.siteUrl = (config.get<string>('SITE_URL') || 'https://matchena.com').replace(/\/$/, '');
  }

  summary(): Promise<string> {
    return this.cached('summary', () => this.build(false));
  }

  full(): Promise<string> {
    return this.cached('full', () => this.build(true));
  }

  private async cached(key: string, produce: () => Promise<string>): Promise<string> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < LlmsService.TTL_MS) return hit.body;
    const body = await produce();
    this.cache.set(key, { at: Date.now(), body });
    return body;
  }

  private url(lang: 'en' | 'ar', path = ''): string {
    return `${this.siteUrl}/${lang}${path}`;
  }

  private faqLink(lang: 'en' | 'ar', path: string, label: string): string {
    if (/^(https?:|mailto:|tel:)/i.test(path)) return `- [${label}](${path})`;
    const clean = path.startsWith('/') ? path : `/${path}`;
    return `- [${label}](${this.url(lang, clean)})`;
  }

  private async build(full: boolean): Promise<string> {
    const [sports, venues, posts, faqs, venueCount] = await Promise.all([
      this.prisma.sportCategory.findMany({ select: { slug: true, nameEn: true, nameAr: true }, orderBy: { slug: 'asc' } }),
      this.prisma.venue.findMany({
        where: { status: 'active' },
        select: {
          slug: true, nameEn: true, nameAr: true, descriptionEn: true, address: true,
          governorate: { select: { nameEn: true } },
          district: { select: { nameEn: true } },
          sports: { select: { sport: { select: { nameEn: true } } } },
        },
        orderBy: [{ ratingCount: 'desc' }, { ratingAvg: 'desc' }],
        take: full ? 300 : 100,
      }),
      this.prisma.blogPost.findMany({
        where: { status: 'published' },
        select: { slug: true, titleEn: true, titleAr: true, subtitleEn: true, subtitleAr: true, contentEn: true, contentAr: true, publishedAt: true },
        orderBy: { publishedAt: 'desc' },
        take: full ? 100 : 50,
      }),
      this.prisma.faqEntry.findMany({ orderBy: { position: 'asc' }, take: 100 }),
      this.prisma.venue.count({ where: { status: 'active' } }),
    ]);

    const out: string[] = [];
    out.push('# Matchena (ماتشنا)', '');
    out.push(
      `> Matchena is a court booking and venue-management platform in Egypt. Players check open slots and clear prices, confirm a booking before they leave the house, and fill short-handed matches with other players. Venue owners run the same courts from a dashboard: calendar, prices, walk-ins, staff and earnings. ${venueCount} active venues across football, padel, tennis, squash, PlayStation lounges, billiards, table tennis and more. Available in Arabic (${this.url('ar')}) and English (${this.url('en')}).`,
      '',
    );
    out.push(
      'Public pages are server-rendered and free to read. Private areas (/app, /owner, /admin, /checkout) require an account and must not be crawled; see robots.txt. Every public page has an Arabic and an English version at the same path under /ar and /en.',
      '',
    );

    out.push('## Main pages', '');
    const main: [string, string, string][] = [
      ['', 'Home', 'Find a sport, see open slots and book.'],
      ['/explore', 'Explore venues', 'Search and filter venues by sport, area and availability.'],
      ['/community', 'Community', 'Open matches, posts and players looking for a game.'],
      ['/leaderboards', 'Leaderboards', 'Top players and teams.'],
      ['/blog', 'Blog', 'Guides and news about playing and booking in Egypt.'],
      ['/how-it-works', 'How it works', 'How booking, payment and confirmation work.'],
      ['/partners', 'For venue owners', 'Run the calendar, prices, staff and earnings, then take bookings.'],
      ['/about', 'About', 'Who we are and what Matchena does.'],
      ['/help', 'Help center', 'Answers for players booking a court and owners running one.'],
      ['/contact', 'Contact', 'Reach the Matchena team.'],
    ];
    for (const [path, name, desc] of main) out.push(`- [${name}](${this.url('en', path)}): ${desc}`);
    out.push(`- [الصفحة الرئيسية بالعربية](${this.url('ar')}): نفس التجربة كاملة بالعربية.`, '');

    if (sports.length) {
      out.push('## Sports and activities', '');
      for (const s of sports) {
        out.push(`- [${label(s.nameEn)} — ${label(s.nameAr)}](${this.url('en', `/sports/${s.slug}`)}): Book ${s.nameEn} venues in Egypt. Venues: ${this.url('en', `/explore?sport=${s.slug}`)}`);
      }
      out.push('');
    }

    if (posts.length) {
      out.push('## Articles', '');
      for (const p of posts) {
        const desc = clip(p.subtitleEn || stripHtml(p.contentEn), 200);
        out.push(`- [${label(p.titleEn)}](${this.url('en', `/blog/${p.slug}`)}): ${desc}`);
        out.push(`  - [${label(p.titleAr)}](${this.url('ar', `/blog/${p.slug}`)}) (العربية)`);
      }
      out.push('');
    }

    if (venues.length) {
      out.push('## Venues', '');
      for (const v of venues) {
        const where = [v.district?.nameEn, v.governorate?.nameEn].filter(Boolean).join(', ');
        const sportNames = [...new Set(v.sports.map((vs) => vs.sport.nameEn))].join(', ');
        const meta = [where, sportNames].filter(Boolean).join(' · ');
        out.push(`- [${label(v.nameEn)} — ${label(v.nameAr)}](${this.url('en', `/venues/${v.slug}`)})${meta ? `: ${meta}` : ''}`);
      }
      out.push('');
    }

    out.push('## Policies', '');
    out.push(`- [Terms of service](${this.url('en', '/terms')})`, `- [Privacy policy](${this.url('en', '/privacy')})`, `- [Refund policy](${this.url('en', '/refund-policy')})`, '');

    if (full) {
      if (faqs.length) {
        out.push('## Frequently asked questions', '');
        for (const f of faqs) {
          out.push(`### ${f.questionEn}`, f.answerEn.trim(), '');
          if (f.ctaPath && f.ctaLabelEn) {
            out.push(this.faqLink('en', f.ctaPath, f.ctaLabelEn), '');
          }
          out.push(`### ${f.questionAr}`, f.answerAr.trim(), '');
          if (f.ctaPath && f.ctaLabelAr) {
            out.push(this.faqLink('ar', f.ctaPath, f.ctaLabelAr), '');
          }
        }
      }
      if (posts.length) {
        out.push('## Article excerpts', '');
        for (const p of posts) {
          out.push(`### ${p.titleEn}`, `Source: ${this.url('en', `/blog/${p.slug}`)}`, clip(stripHtml(p.contentEn), 1500), '');
          out.push(`### ${p.titleAr}`, `المصدر: ${this.url('ar', `/blog/${p.slug}`)}`, clip(stripHtml(p.contentAr), 1500), '');
        }
      }
      if (venues.length) {
        out.push('## Venue details', '');
        for (const v of venues.filter((x) => x.descriptionEn)) {
          out.push(`### ${v.nameEn}`, `Source: ${this.url('en', `/venues/${v.slug}`)}`, v.address ? `Address: ${v.address}` : '', clip(stripHtml(v.descriptionEn!), 600), '');
        }
      }
    } else {
      out.push('## Optional', '');
      out.push(`- [Full content for LLMs](${this.siteUrl}/llms-full.txt): FAQs, article excerpts and venue descriptions in one file.`);
      out.push(`- [Sitemap](${this.siteUrl}/sitemap.xml): Every public venue, sport, blog, community and landing URL.`, '');
    }
    return `${out.filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n')}\n`;
  }
}
