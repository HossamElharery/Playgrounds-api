import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AchievementsService } from './achievements.service';
import { CoinGrantService } from './coin-grant.service';
import { GameResultsService } from './game-results.service';
import { RewardsService } from './rewards.service';
import { RewardsController } from './rewards.controller';

@Module({
  imports: [NotificationsModule],
  providers: [RewardsService, CoinGrantService, AchievementsService, GameResultsService],
  controllers: [RewardsController],
  exports: [RewardsService, CoinGrantService, AchievementsService, GameResultsService],
})
export class RewardsModule {}
