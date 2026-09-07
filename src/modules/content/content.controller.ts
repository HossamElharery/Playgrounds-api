import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { ContentService } from './content.service';
import { CreateBlogPostDto, UpdateBlogPostDto } from './dto/blog-post.dto';
import { CreateBlogCategoryDto } from './dto/blog-category.dto';
import { UpsertBannerDto } from './dto/banner.dto';
import { UpsertFaqDto } from './dto/faq.dto';
import { CreateSupportInquiryDto } from './dto/support-inquiry.dto';
import {
  ListBannersQueryDto,
  ListBlogQueryDto,
  ListSupportQueryDto,
} from './dto/list-queries.dto';

@ApiTags('content')
@Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Public()
  @Get('sports')
  listSports() {
    return this.content.listSports();
  }

  @Public()
  @Get('amenities')
  listAmenities() {
    return this.content.listAmenities();
  }

  // ---- Blog (public: published only. Admin list: GET /admin/blog?status=) ----
  @Public()
  @Get('blog')
  @ApiOperation({
    summary: 'List published blog posts',
    description:
      'Always filters to PublishStatus=published. Do **not** send `status` (that causes 400). Admin drafts: GET /admin/blog?status=draft|published|archived. Each item includes titleEn/titleAr, contentEn/contentAr, and slug for /blog/:slug.',
  })
  async listBlog(@Query() q: ListBlogQueryDto) {
    const { items, pagination } = await this.content.listBlogPosts(
      q.page,
      q.perPage,
      'published',
      q.categoryId,
    );
    return { message: 'ok', result: items, pagination };
  }

  @Public()
  @Get('blog/categories')
  @ApiOperation({ summary: 'List blog categories' })
  listBlogCategories() {
    return this.content.listBlogCategories();
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Post('admin/blog/categories')
  createBlogCategory(@Body() dto: CreateBlogCategoryDto) {
    return this.content.createBlogCategory(dto);
  }

  @Public()
  @Get('blog/:slugOrId')
  @ApiOperation({
    summary: 'Get a blog post by slug or id',
    description:
      'Each post has titleEn/titleAr, subtitleEn/subtitleAr, contentEn/contentAr. Pick the pair that matches the UI locale.',
  })
  getBlog(@Param('slugOrId') slugOrId: string) {
    return this.content.getBlogPost(slugOrId, true);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get('admin/blog')
  @ApiOperation({
    summary: 'Admin: list blog posts (optional status filter)',
    description:
      'status must be lowercase draft | published | archived. There is no value "Active". Omit status to list all.',
  })
  async listBlogAdmin(@Query() q: ListBlogQueryDto) {
    const { items, pagination } = await this.content.listBlogPosts(
      q.page,
      q.perPage,
      q.status,
      q.categoryId,
    );
    return { message: 'ok', result: items, pagination };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Post('admin/blog')
  createBlog(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBlogPostDto,
  ) {
    return this.content.createBlogPost(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Patch('admin/blog/:id')
  updateBlog(@Param('id') id: string, @Body() dto: UpdateBlogPostDto) {
    return this.content.updateBlogPost(id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Delete('admin/blog/:id')
  deleteBlog(@Param('id') id: string) {
    return this.content.deleteBlogPost(id);
  }

  // ---- Banners ----
  @Public()
  @Get('banners')
  listBanners(@Query() q: ListBannersQueryDto) {
    return this.content.listBanners(q.placement);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get('admin/banners')
  listBannersAdmin() {
    return this.content.listBannersAdmin();
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Post('admin/banners')
  createBanner(@Body() dto: UpsertBannerDto) {
    return this.content.createBanner(dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Patch('admin/banners/:id')
  updateBanner(@Param('id') id: string, @Body() dto: Partial<UpsertBannerDto>) {
    return this.content.updateBanner(id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Delete('admin/banners/:id')
  deleteBanner(@Param('id') id: string) {
    return this.content.deleteBanner(id);
  }

  // ---- FAQ ----
  @Public()
  @Get('faq')
  listFaq() {
    return this.content.listFaq();
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Post('admin/faq')
  createFaq(@Body() dto: UpsertFaqDto) {
    return this.content.createFaq(dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Patch('admin/faq/:id')
  updateFaq(@Param('id') id: string, @Body() dto: Partial<UpsertFaqDto>) {
    return this.content.updateFaq(id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Delete('admin/faq/:id')
  deleteFaq(@Param('id') id: string) {
    return this.content.deleteFaq(id);
  }

  // ---- Support / contact ----
  @Public()
  @Post('support')
  createSupportInquiry(@Body() dto: CreateSupportInquiryDto) {
    return this.content.createSupportInquiry(dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get('admin/support')
  async listSupportInquiries(@Query() q: ListSupportQueryDto) {
    const { items, pagination } = await this.content.listSupportInquiries(
      q.page,
      q.perPage,
      q.status,
    );
    return { message: 'ok', result: items, pagination };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Patch('admin/support/:id/read')
  markRead(@Param('id') id: string) {
    return this.content.markSupportInquiryRead(id);
  }
}
