import { Module } from '@nestjs/common';
import { SeoDiscoveryController } from './seo-discovery.controller';
import { SitemapService } from './sitemap.service';
import { IndexNowService } from './index-now.service';
import { LlmsService } from './llms.service';
import { PageSeoService } from './page-seo.service';
import { LocalLandingService } from './local-landing.service';

@Module({
  controllers: [SeoDiscoveryController],
  providers: [SitemapService, LlmsService, IndexNowService, PageSeoService, LocalLandingService],
  exports: [IndexNowService, LocalLandingService],
})
export class SeoDiscoveryModule {}
