import { Body, Controller, Get, Header, Param, Put, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { IndexNowService } from './index-now.service';
import { SitemapService } from './sitemap.service';
import { LlmsService } from './llms.service';
import { PageSeoService } from './page-seo.service';
import { UpdatePageSeoDto } from './page-seo.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';

@Controller('seo')
export class SeoDiscoveryController {
  constructor(
    private readonly sitemap: SitemapService,
    private readonly indexNow: IndexNowService,
    private readonly pageSeo: PageSeoService,
    private readonly llmsService: LlmsService,
  ) {}

  @Public()
  @Get('sitemap.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async index(@Res() response: Response) { response.send(await this.sitemap.index()); }

  @Public()
  @Get('sitemaps/venues.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async venues(@Res() response: Response) { response.send(await this.sitemap.venues()); }

  @Public()
  @Get('sitemaps/landings.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async landings(@Res() response: Response) { response.send(await this.sitemap.landings()); }

  @Public()
  @Get('sitemaps/blog.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async blog(@Res() response: Response) { response.send(await this.sitemap.blog()); }

  @Public()
  @Get('sitemaps/sports.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async sports(@Res() response: Response) { response.send(await this.sitemap.sports()); }

  @Public()
  @Get('sitemaps/posts.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async posts(@Res() response: Response) { response.send(await this.sitemap.posts()); }

  @Public()
  @Get('sitemaps/hashtags.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async hashtags(@Res() response: Response) { response.send(await this.sitemap.hashtags()); }

  @Public()
  @Get('llms.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async llms(@Res() response: Response) { response.send(await this.llmsService.summary()); }

  @Public()
  @Get('llms-full.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async llmsFull(@Res() response: Response) { response.send(await this.llmsService.full()); }

  @Public()
  @Get('sitemaps/static.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  staticPages(@Res() response: Response) { response.send(this.sitemap.staticPages()); }

  @Get('indexnow/status')
  @UseGuards(AuthGuard)
  @Roles('admin')
  indexNowStatus() { return this.indexNow.status(); }

  @Public()
  @Get('pages/:key')
  page(@Param('key') key: string) { return this.pageSeo.get(key); }

  @Get('pages')
  @UseGuards(AuthGuard)
  @Roles('admin')
  pages() { return this.pageSeo.list(); }

  @Put('pages/:key')
  @UseGuards(AuthGuard)
  @Roles('admin')
  updatePage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Body() dto: UpdatePageSeoDto,
  ) { return this.pageSeo.update(user.id, key, dto); }
}
