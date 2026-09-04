export interface UploadResult {
  key: string;
  url: string;
}

export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';

export interface StorageProvider {
  uploadBuffer(
    buffer: Buffer,
    originalName: string,
    mimeType: string,
    prefix?: string,
  ): Promise<UploadResult>;
  deleteObject(key: string): Promise<void>;
  urlFor(key: string): string;
}
