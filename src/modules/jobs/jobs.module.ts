import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [RealtimeModule],
  providers: [JobsService],
})
export class JobsModule {}
