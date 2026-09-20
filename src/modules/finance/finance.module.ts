import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommissionService } from './commission.service';
import { LedgerService } from './ledger.service';

@Module({
  imports: [NotificationsModule],
  providers: [CommissionService, LedgerService],
  exports: [CommissionService, LedgerService],
})
export class FinanceModule {}
