import { RewardsModule } from '../rewards/rewards.module';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { LobbyWorldModule } from '../lobby-world/lobby-world.module';
import { CamoController } from './camo.controller';
import { CamoGateway } from './camo.gateway';
import { CamoAdminController } from './camo-admin.controller';
import { CamoProgressService } from './camo-progress.service';
import { CamoPuzzleService } from './camo-puzzle.service';
import { CamoModerationService } from './camo-moderation.service';
import { CamoService } from './camo.service';

@Module({
  imports: [AuthModule, LobbyWorldModule, RealtimeModule, RewardsModule],
  providers: [CamoService, CamoGateway, CamoModerationService, CamoPuzzleService, CamoProgressService],
  controllers: [CamoController, CamoAdminController],
  exports: [CamoService],
})
export class CamoModule {}
