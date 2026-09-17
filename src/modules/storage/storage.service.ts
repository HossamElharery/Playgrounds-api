import { Inject, Injectable } from '@nestjs/common';
import {
  STORAGE_PROVIDER,
  StorageProvider,
  UploadResult,
  PresignedUpload,
} from './storage.interface';

@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
  ) {}

  uploadBuffer(
    buffer: Buffer,
    originalName: string,
    mimeType: string,
    prefix?: string,
  ): Promise<UploadResult> {
    return this.provider.uploadBuffer(buffer, originalName, mimeType, prefix);
  }

  deleteObject(key: string): Promise<void> {
    return this.provider.deleteObject(key);
  }

  urlFor(key: string): string {
    return this.provider.urlFor(key);
  }

  keyFromUrl(url: string): string | undefined {
    return this.provider.keyFromUrl(url);
  }

  supportsPresign(): boolean {
    return typeof this.provider.createPresignedPut === 'function';
  }

  createPresignedPut(
    originalName: string,
    mimeType: string,
    prefix?: string,
  ): Promise<PresignedUpload> {
    if (!this.provider.createPresignedPut) {
      throw new Error('Presigned uploads are not available for this storage provider');
    }
    return this.provider.createPresignedPut(originalName, mimeType, prefix);
  }
}
