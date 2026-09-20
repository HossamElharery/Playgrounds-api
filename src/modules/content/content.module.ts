import { Module } from '@nestjs/common';
import { ContentService } from './content.service';
import { ContentController } from './content.controller';
import { SeoDiscoveryModule } from '../seo/seo-discovery.module';

@Module({
  imports: [SeoDiscoveryModule],
  providers: [ContentService],
  controllers: [ContentController],
})
export class ContentModule {}
