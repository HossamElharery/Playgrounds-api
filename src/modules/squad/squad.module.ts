import { Module } from '@nestjs/common';
import { SquadService } from './squad.service';
import { SquadController } from './squad.controller';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [RealtimeModule, NotificationsModule],
  providers: [SquadService],
  controllers: [SquadController],
})
export class SquadModule {}
