import { Module } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { PaymentsModule } from '../payments/payments.module';
import { RewardsModule } from '../rewards/rewards.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FinanceModule } from '../finance/finance.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { BookingNotifier } from './booking-notifier.service';
import { BookingNoticeReconciler } from './booking-notice-reconciler.service';

@Module({
  imports: [PaymentsModule, RewardsModule, NotificationsModule, FinanceModule, RealtimeModule],
  providers: [BookingsService, BookingNotifier, BookingNoticeReconciler],
  controllers: [BookingsController],
  exports: [BookingsService, BookingNotifier],
})
export class BookingsModule {}
