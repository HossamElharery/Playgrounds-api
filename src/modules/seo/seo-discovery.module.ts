import { Module } from '@nestjs/common';
import { SeoDiscoveryController } from './seo-discovery.controller';
import { SitemapService } from './sitemap.service';
import { IndexNowService } from './index-now.service';

@Module({
  controllers: [SeoDiscoveryController],
  providers: [SitemapService, IndexNowService],
  exports: [IndexNowService],
})
export class SeoDiscoveryModule {}
