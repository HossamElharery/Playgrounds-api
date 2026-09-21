import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { ManagementService } from './management.service';
import { ManagementController } from './management.controller';
import { BookingsModule } from '../bookings/bookings.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { VenueSeoController } from './venue-seo.controller';
import { VenueSeoService } from './venue-seo.service';
import { AdminFinanceService } from './admin-finance.service';
import { AdminFinanceController } from './admin-finance.controller';
import { OwnerModule } from '../owner/owner.module';
import { DemoController } from './demo/demo.controller';
import { DemoService } from './demo/demo.service';
import { FinanceModule } from '../finance/finance.module';
import { PaymentsModule } from '../payments/payments.module';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';

@Module({
  imports: [
    NotificationsModule,
    BookingsModule,
    RealtimeModule,
    OwnerModule,
    FinanceModule,
    PaymentsModule,
  ],
  providers: [
    AdminService,
    ManagementService,
    VenueSeoService,
    AdminFinanceService,
    IdempotencyInterceptor,
    DemoService,
  ],
  controllers: [AdminController, ManagementController, VenueSeoController, AdminFinanceController, DemoController],
  exports: [AdminService, AdminFinanceService],
})
export class AdminModule {}
