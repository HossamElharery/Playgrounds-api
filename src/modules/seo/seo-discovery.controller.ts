import { Controller, Get, Header, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { IndexNowService } from './index-now.service';
import { SitemapService } from './sitemap.service';

@Controller('seo')
export class SeoDiscoveryController {
  constructor(
    private readonly sitemap: SitemapService,
    private readonly indexNow: IndexNowService,
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
  @Get('sitemaps/static.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  staticPages(@Res() response: Response) { response.send(this.sitemap.staticPages()); }

  @Get('indexnow/status')
  @UseGuards(AuthGuard)
  @Roles('admin')
  indexNowStatus() { return this.indexNow.status(); }
}
