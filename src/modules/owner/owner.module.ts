import { Module } from '@nestjs/common';
import { OwnerService } from './owner.service';
import { OwnerController } from './owner.controller';
import { BookingsModule } from '../bookings/bookings.module';

@Module({
  imports: [BookingsModule],
  providers: [OwnerService],
  controllers: [OwnerController],
})
export class OwnerModule {}
