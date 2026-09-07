import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

  // ---- Blog ----
  async listBlogPosts(
    page: number,
    perPage: number,
    status?: string,
    categoryId?: string,
  ) {
    const where = {
      ...(status ? { status: status as PublishStatus } : {}),
      ...(categoryId ? { categoryId } : {}),
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
    return this.prisma.blogPost.create({
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
      },
    });
  }

  async updateBlogPost(id: string, dto: UpdateBlogPostDto) {
    const existing = await this.getBlogPost(id);
    const status = dto.status
      ? (dto.status as PublishStatus)
      : existing.status;
    const slug = dto.slug
      ? await this.ensureUniqueSlug(dto.slug, existing.id)
      : undefined;
    return this.prisma.blogPost.update({
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
      },
    });
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
  listFaq() {
    return this.prisma.faqEntry.findMany({ orderBy: { position: 'asc' } });
  }

  createFaq(dto: UpsertFaqDto) {
    return this.prisma.faqEntry.create({ data: dto });
  }

  updateFaq(id: string, dto: Partial<UpsertFaqDto>) {
    return this.prisma.faqEntry.update({ where: { id }, data: dto });
  }

  deleteFaq(id: string) {
    return this.prisma.faqEntry.delete({ where: { id } });
  }

  // ---- Support inquiries ----
  createSupportInquiry(dto: CreateSupportInquiryDto) {
    return this.prisma.supportInquiry.create({ data: dto });
  }

  async listSupportInquiries(page: number, perPage: number, status?: string) {
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([
      this.prisma.supportInquiry.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.supportInquiry.count({ where }),
    ]);
    return { items, pagination: buildPagination(page, perPage, total) };
  }

  markSupportInquiryRead(id: string) {
    return this.prisma.supportInquiry.update({
      where: { id },
      data: { status: 'read', readAt: new Date() },
    });
  }

  listSports() {
    return this.prisma.sportCategory.findMany({ orderBy: { nameEn: 'asc' } });
  }

  listAmenities() {
    return this.prisma.amenity.findMany({ orderBy: { nameEn: 'asc' } });
  }
}
