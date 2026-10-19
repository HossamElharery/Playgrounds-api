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
import { PaymentIntentsService } from './payment-intents.service';
import { PaymentReconciler } from './payment-reconciler.service';
import { BookingReminderService } from './booking-reminder.service';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [PaymentsModule, RewardsModule, NotificationsModule, FinanceModule, RealtimeModule],
  providers: [BookingsService, BookingNotifier, BookingNoticeReconciler, PaymentIntentsService, PaymentReconciler, BookingReminderService],
  controllers: [BookingsController, PaymentsController],
  exports: [BookingsService, BookingNotifier, PaymentIntentsService],
})
export class BookingsModule {}
