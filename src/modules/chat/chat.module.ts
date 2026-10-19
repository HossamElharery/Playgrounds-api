import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { MessageTrustService } from './message-trust.service';
import { ChatController } from './chat.controller';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [RealtimeModule, NotificationsModule, StorageModule],
  providers: [ChatService, MessageTrustService],
  controllers: [ChatController],
  exports: [ChatService],
})
export class ChatModule {}
