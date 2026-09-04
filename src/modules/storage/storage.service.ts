import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_PROVIDER, StorageProvider, UploadResult } from './storage.interface';

@Injectable()
export class StorageService {
  constructor(@Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider) {}

  uploadBuffer(buffer: Buffer, originalName: string, mimeType: string, prefix?: string): Promise<UploadResult> {
    return this.provider.uploadBuffer(buffer, originalName, mimeType, prefix);
  }

  deleteObject(key: string): Promise<void> {
    return this.provider.deleteObject(key);
  }

  urlFor(key: string): string {
    return this.provider.urlFor(key);
  }
}
