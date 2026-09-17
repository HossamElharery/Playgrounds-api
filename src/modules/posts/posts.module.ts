import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../storage/storage.module';
import { AnalyticsService } from './analytics.service';
import { CoinsRewardService } from './coins-reward.service';
import { FollowService } from './follow.service';
import { HashtagService } from './hashtag.service';
import { MediaUploadController } from './media-upload.controller';
import { MediaUploadService } from './media-upload.service';
import { PostModerationController } from './post-moderation.controller';
import { PostModerationService } from './post-moderation.service';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

@Module({
  imports: [NotificationsModule, StorageModule],
  controllers: [PostsController, MediaUploadController, PostModerationController],
  providers: [
    PostsService,
    HashtagService,
    FollowService,
    MediaUploadService,
    PostModerationService,
    CoinsRewardService,
    AnalyticsService,
  ],
  exports: [PostsService, FollowService, CoinsRewardService],
})
export class PostsModule {}
