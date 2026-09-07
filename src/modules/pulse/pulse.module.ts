import { Module } from '@nestjs/common';
import { PulseService } from './pulse.service';
import { PulseController } from './pulse.controller';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [RealtimeModule],
  providers: [PulseService],
  controllers: [PulseController],
  exports: [PulseService],
})
export class PulseModule {}
