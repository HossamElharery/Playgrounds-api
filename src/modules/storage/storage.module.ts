import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import { STORAGE_PROVIDER } from './storage.interface';
import { LocalDiskStorageProvider } from './local-disk-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    LocalDiskStorageProvider,
    S3StorageProvider,
    {
      provide: STORAGE_PROVIDER,
      useFactory: (
        config: ConfigService,
        local: LocalDiskStorageProvider,
        s3: S3StorageProvider,
      ) => (config.get<string>('STORAGE_PROVIDER') === 's3' ? s3 : local),
      inject: [ConfigService, LocalDiskStorageProvider, S3StorageProvider],
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
