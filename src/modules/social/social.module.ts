import { Module } from '@nestjs/common';
import { FriendsService } from './friends.service';
import { MatchPostsService } from './match-posts.service';
import { TeamsService } from './teams.service';
import { SocialController } from './social.controller';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [RealtimeModule, NotificationsModule],
  providers: [FriendsService, MatchPostsService, TeamsService],
  controllers: [SocialController],
  exports: [FriendsService, MatchPostsService, TeamsService],
})
export class SocialModule {}
