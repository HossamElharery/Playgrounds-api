import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { LobbyWorldModule } from '../lobby-world/lobby-world.module';
import { CamoController } from './camo.controller';
import { CamoGateway } from './camo.gateway';
import { CamoAdminController } from './camo-admin.controller';
import { CamoModerationService } from './camo-moderation.service';
import { CamoService } from './camo.service';

@Module({
  imports: [AuthModule, LobbyWorldModule, RealtimeModule],
  providers: [CamoService, CamoGateway, CamoModerationService],
  controllers: [CamoController, CamoAdminController],
  exports: [CamoService],
})
export class CamoModule {}
