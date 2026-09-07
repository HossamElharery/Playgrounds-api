import { Module } from '@nestjs/common';
import { VenuesService } from './venues.service';
import { VenuesController } from './venues.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  providers: [VenuesService],
  controllers: [VenuesController],
  exports: [VenuesService],
})
export class VenuesModule {}
