import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { StorageModule } from '../storage/storage.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { GeoModule } from '../geo/geo.module';

@Module({
  imports: [StorageModule, RealtimeModule, GeoModule],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
