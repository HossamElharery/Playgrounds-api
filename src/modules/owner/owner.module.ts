import { Module } from '@nestjs/common';
import { OwnerService } from './owner.service';
import { OwnerController } from './owner.controller';
import { GeminiNluService } from './gemini-nlu.service';
import { BookingsModule } from '../bookings/bookings.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [BookingsModule, AiModule],
  providers: [OwnerService, GeminiNluService],
  controllers: [OwnerController],
})
export class OwnerModule {}
