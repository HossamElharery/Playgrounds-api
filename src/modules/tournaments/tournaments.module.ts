import { Module } from '@nestjs/common';
import { TournamentsService } from './tournaments.service';
import { TournamentsController } from './tournaments.controller';
import { SocialModule } from '../social/social.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [SocialModule, RealtimeModule],
  providers: [TournamentsService],
  controllers: [TournamentsController],
})
export class TournamentsModule {}
