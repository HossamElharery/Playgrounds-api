import { Module } from '@nestjs/common';
import { ContentService } from './content.service';
import { ContentController } from './content.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { SeoDiscoveryModule } from '../seo/seo-discovery.module';

@Module({
  imports: [SeoDiscoveryModule, NotificationsModule],
  providers: [ContentService],
  controllers: [ContentController],
})
export class ContentModule {}
