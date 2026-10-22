import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CamoController } from './camo.controller';
import { CamoGateway } from './camo.gateway';
import { CamoService } from './camo.service';

@Module({
  imports: [AuthModule],
  providers: [CamoService, CamoGateway],
  controllers: [CamoController],
  exports: [CamoService],
})
export class CamoModule {}
