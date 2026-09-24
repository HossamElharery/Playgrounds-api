import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { MorphsService } from './morphs.service';
import { MorphsController } from './morphs.controller';
import { AdminMorphsController } from './admin-morphs.controller';
import { MorphsEnabledGuard } from './morphs-enabled.guard';

@Module({
  imports: [RealtimeModule],
  providers: [MorphsService, MorphsEnabledGuard],
  controllers: [MorphsController, AdminMorphsController],
  exports: [MorphsService],
})
export class MorphsModule {}
