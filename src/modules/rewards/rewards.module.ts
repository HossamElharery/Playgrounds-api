import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { NotificationsModule } from '../notifications/notifications.module';
import { AchievementsService } from './achievements.service';
import { CoinGrantService } from './coin-grant.service';
import { GameResultsService } from './game-results.service';
import { BookingQualificationService } from './risk/booking-qualification.service';
import { DeviceLinksService } from './risk/device-links.service';
import { DeviceTrackingInterceptor } from './risk/device-tracking.interceptor';
import { RewardsRiskController } from './risk/rewards-risk.controller';
import { RewardsRiskService } from './risk/rewards-risk.service';
import { TrustService } from './risk/trust.service';
import { RewardsService } from './rewards.service';
import { RewardsController } from './rewards.controller';

@Module({
  imports: [NotificationsModule],
  providers: [
    RewardsService,
    CoinGrantService,
    AchievementsService,
    GameResultsService,
    DeviceLinksService,
    BookingQualificationService,
    TrustService,
    RewardsRiskService,
    { provide: APP_INTERCEPTOR, useClass: DeviceTrackingInterceptor },
  ],
  controllers: [RewardsController, RewardsRiskController],
  exports: [
    RewardsService,
    CoinGrantService,
    AchievementsService,
    GameResultsService,
    DeviceLinksService,
    BookingQualificationService,
    TrustService,
  ],
})
export class RewardsModule {}
