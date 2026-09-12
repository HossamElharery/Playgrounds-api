import { Module } from '@nestjs/common';
import { SeoDiscoveryController } from './seo-discovery.controller';
import { SitemapService } from './sitemap.service';
import { IndexNowService } from './index-now.service';
import { PageSeoService } from './page-seo.service';

@Module({
  controllers: [SeoDiscoveryController],
  providers: [SitemapService, IndexNowService, PageSeoService],
  exports: [IndexNowService],
})
export class SeoDiscoveryModule {}
