import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IndexNowService } from '../seo/index-now.service';
import { EmailService } from '../email/email.service';
import { PublishStatus } from '@prisma/client';
import { CreateBlogPostDto, UpdateBlogPostDto } from './dto/blog-post.dto';
import { CreateBlogCategoryDto } from './dto/blog-category.dto';
import { UpsertBannerDto } from './dto/banner.dto';
import { UpsertFaqDto } from './dto/faq.dto';
import { CreateSupportInquiryDto } from './dto/support-inquiry.dto';
import { buildPagination } from '../../common/dto/page-query.dto';

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexNow: IndexNowService,
    private readonly email: EmailService,
  ) {}

  /** Tell IndexNow-enabled engines (Bing, Yandex, …) about a published article; never blocks the save. */
  private pingBlog(post: { slug: string; status: PublishStatus }): void {
    if (post.status !== 'published') return;
    const slug = encodeURIComponent(post.slug);
    void this.indexNow
      .notifyUrls([`/ar/blog/${slug}`, `/en/blog/${slug}`, '/ar/blog', '/en/blog'])
      .catch(() => undefined);
  }

  // ---- Blog ----
  async listBlogPosts(
    page: number,
    perPage: number,
    status?: string,
    categoryId?: string,
    relatedSportSlug?: string,
  ) {
    const where = {
      ...(status ? { status: status as PublishStatus } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(relatedSportSlug ? { relatedSportSlug } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.blogPost.findMany({
        where,
        include: {
          category: true,
          author: { select: { id: true, name: true } },
        },
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: [
          { publishedAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
      }),
      this.prisma.blogPost.count({ where }),
    ]);
    return { items, pagination: buildPagination(page, perPage, total) };
  }

  async getBlogPost(slugOrId: string, publicOnly = false) {
    const post = await this.prisma.blogPost.findFirst({
      where: {
        OR: [{ slug: slugOrId }, { id: slugOrId }],
        ...(publicOnly ? { status: 'published' as PublishStatus } : {}),
      },
      include: { category: true, author: { select: { id: true, name: true } } },
    });
    if (!post) throw new NotFoundException('Post not found');
    return post;
  }

  async createBlogPost(authorId: string, dto: CreateBlogPostDto) {
    const status = (dto.status as PublishStatus) ?? 'draft';
    const slug = await this.ensureUniqueSlug(
      dto.slug?.trim() || slugify(dto.titleEn) || `post-${Date.now()}`,
    );
    const created = await this.prisma.blogPost.create({
      data: {
        slug,
        titleEn: dto.titleEn,
        titleAr: dto.titleAr,
        subtitleEn: dto.subtitleEn,
        subtitleAr: dto.subtitleAr,
        coverImageUrl: dto.coverImageUrl,
        contentEn: dto.contentEn,
        contentAr: dto.contentAr,
        categoryId: dto.categoryId,
        authorId,
        status,
        publishedAt: status === 'published' ? new Date() : null,
        ctaLabelEn: dto.ctaLabelEn,
        ctaLabelAr: dto.ctaLabelAr,
        ctaHref: dto.ctaHref,
        relatedSportSlug: dto.relatedSportSlug,
        seoTitleEn: dto.seoTitleEn?.trim() || null,
        seoTitleAr: dto.seoTitleAr?.trim() || null,
        seoDescriptionEn: dto.seoDescriptionEn?.trim() || null,
        seoDescriptionAr: dto.seoDescriptionAr?.trim() || null,
        keywordsEn: dto.keywordsEn?.trim() || null,
        keywordsAr: dto.keywordsAr?.trim() || null,
      },
    });
    this.pingBlog(created);
    return created;
  }

  async updateBlogPost(id: string, dto: UpdateBlogPostDto) {
    const existing = await this.getBlogPost(id);
    const status = dto.status
      ? (dto.status as PublishStatus)
      : existing.status;
    const slug = dto.slug
      ? await this.ensureUniqueSlug(dto.slug, existing.id)
      : undefined;
    const updated = await this.prisma.blogPost.update({
      where: { id: existing.id },
      data: {
        ...(slug ? { slug } : {}),
        titleEn: dto.titleEn,
        titleAr: dto.titleAr,
        subtitleEn: dto.subtitleEn,
        subtitleAr: dto.subtitleAr,
        coverImageUrl: dto.coverImageUrl,
        contentEn: dto.contentEn,
        contentAr: dto.contentAr,
        categoryId: dto.categoryId,
        status,
        publishedAt:
          status === 'published'
            ? (existing.publishedAt ?? new Date())
            : existing.publishedAt,
        ctaLabelEn: dto.ctaLabelEn,
        ctaLabelAr: dto.ctaLabelAr,
        ctaHref: dto.ctaHref,
        relatedSportSlug: dto.relatedSportSlug,
        ...(dto.seoTitleEn !== undefined ? { seoTitleEn: dto.seoTitleEn.trim() || null } : {}),
        ...(dto.seoTitleAr !== undefined ? { seoTitleAr: dto.seoTitleAr.trim() || null } : {}),
        ...(dto.seoDescriptionEn !== undefined ? { seoDescriptionEn: dto.seoDescriptionEn.trim() || null } : {}),
        ...(dto.seoDescriptionAr !== undefined ? { seoDescriptionAr: dto.seoDescriptionAr.trim() || null } : {}),
        ...(dto.keywordsEn !== undefined ? { keywordsEn: dto.keywordsEn.trim() || null } : {}),
        ...(dto.keywordsAr !== undefined ? { keywordsAr: dto.keywordsAr.trim() || null } : {}),
      },
    });
    this.pingBlog(updated);
    return updated;
  }

  async deleteBlogPost(id: string) {
    const existing = await this.getBlogPost(id);
    return this.prisma.blogPost.delete({ where: { id: existing.id } });
  }

  listBlogCategories() {
    return this.prisma.blogCategory.findMany({ orderBy: { nameEn: 'asc' } });
  }

  createBlogCategory(dto: CreateBlogCategoryDto) {
    return this.prisma.blogCategory.create({ data: dto });
  }

  private async ensureUniqueSlug(raw: string, exceptId?: string) {
    const base = slugify(raw) || `post-${Date.now()}`;
    let candidate = base;
    let n = 2;
    while (true) {
      const clash = await this.prisma.blogPost.findUnique({
        where: { slug: candidate },
      });
      if (!clash || clash.id === exceptId) return candidate;
      candidate = `${base}-${n}`;
      n += 1;
    }
  }

  // ---- Banners ----
  listBanners(placement?: string) {
    return this.prisma.banner.findMany({
      where: { active: true, ...(placement ? { placement } : {}) },
      orderBy: { position: 'asc' },
    });
  }

  listBannersAdmin() {
    return this.prisma.banner.findMany({ orderBy: { position: 'asc' } });
  }

  createBanner(dto: UpsertBannerDto) {
    return this.prisma.banner.create({ data: dto });
  }

  async updateBanner(id: string, dto: Partial<UpsertBannerDto>) {
    return this.prisma.banner.update({ where: { id }, data: dto });
  }

  deleteBanner(id: string) {
    return this.prisma.banner.delete({ where: { id } });
  }

  // ---- FAQ ----
  private pingHelp(): void {
    void this.indexNow
      .notifyUrls(['/ar/help', '/en/help'])
      .catch(() => undefined);
  }

  listFaq() {
    return this.prisma.faqEntry.findMany({
      orderBy: [{ position: 'asc' }, { questionEn: 'asc' }],
    });
  }

  async createFaq(dto: UpsertFaqDto) {
    const position =
      dto.position ??
      ((await this.prisma.faqEntry.aggregate({ _max: { position: true } }))._max
        .position ?? -1) + 1;
    const created = await this.prisma.faqEntry.create({
      data: {
        questionEn: dto.questionEn,
        questionAr: dto.questionAr,
        answerEn: dto.answerEn,
        answerAr: dto.answerAr,
        category: dto.category ?? 'booking',
        position,
        ...this.faqCta(dto),
      },
    });
    this.pingHelp();
    return created;
  }

  async updateFaq(id: string, dto: Partial<UpsertFaqDto>) {
    const updated = await this.prisma.faqEntry.update({
      where: { id },
      data: {
        ...dto,
        ...this.faqCta(dto),
      },
    });
    this.pingHelp();
    return updated;
  }

  private faqCta(dto: Partial<UpsertFaqDto>): {
    ctaPath?: string | null;
    ctaLabelEn?: string | null;
    ctaLabelAr?: string | null;
  } {
    const blank = (value?: string) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : null;
    };
    return {
      ...(dto.ctaPath !== undefined ? { ctaPath: blank(dto.ctaPath) } : {}),
      ...(dto.ctaLabelEn !== undefined ? { ctaLabelEn: blank(dto.ctaLabelEn) } : {}),
      ...(dto.ctaLabelAr !== undefined ? { ctaLabelAr: blank(dto.ctaLabelAr) } : {}),
    };
  }

  async deleteFaq(id: string) {
    const deleted = await this.prisma.faqEntry.delete({ where: { id } });
    this.pingHelp();
    return deleted;
  }

  // ---- Support inquiries ----
  async createSupportInquiry(dto: CreateSupportInquiryDto, userId?: string) {
    const inquiry = await this.prisma.supportInquiry.create({
      data: {
        fullName: dto.fullName,
        email: dto.email,
        phone: dto.phone ?? '',
        message: dto.message,
        ...(userId ? { userId } : {}),
      },
    });
    try {
      await this.email.sendSupportInquiry({
        fullName: inquiry.fullName,
        email: inquiry.email,
        phone: inquiry.phone || undefined,
        message: inquiry.message,
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Support inquiry ${inquiry.id} saved but email failed: ${detail}`,
      );
    }
    return inquiry;
  }

  async listSupportInquiries(page: number, perPage: number, status?: string) {
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([
      this.prisma.supportInquiry.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true } } },
      }),
      this.prisma.supportInquiry.count({ where }),
    ]);
    return { items, pagination: buildPagination(page, perPage, total) };
  }

  async markSupportInquiryRead(id: string) {
    const existing = await this.prisma.supportInquiry.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Support inquiry not found');
    return this.prisma.supportInquiry.update({
      where: { id },
      data: { status: 'read', readAt: new Date() },
      include: { user: { select: { id: true, name: true } } },
    });
  }

  listSports() {
    return this.prisma.sportCategory.findMany({ orderBy: { nameEn: 'asc' } });
  }

  listAmenities() {
    return this.prisma.amenity.findMany({ orderBy: { nameEn: 'asc' } });
  }
}
