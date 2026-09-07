import { Module } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PaymentsModule],
  providers: [BookingsService],
  controllers: [BookingsController],
  exports: [BookingsService],
})
export class BookingsModule {}
