import { Module } from '@nestjs/common';
import { PulseService } from './pulse.service';
import { PulseController } from './pulse.controller';
import { RealtimeModule } from '../realtime/realtime.module';
import { SocialModule } from '../social/social.module';

@Module({
  imports: [RealtimeModule, SocialModule],
  providers: [PulseService],
  controllers: [PulseController],
  exports: [PulseService],
})
export class PulseModule {}
