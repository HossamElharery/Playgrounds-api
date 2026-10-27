export interface UploadResult {
  key: string;
  url: string;
}

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  key: string;
}

export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';

export interface StorageProvider {
  uploadBuffer(
    buffer: Buffer,
    originalName: string,
    mimeType: string,
    prefix?: string,
  ): Promise<UploadResult>;
  /** Same as uploadBuffer, streamed from a file so large videos never sit in memory. */
  uploadFile(
    filePath: string,
    originalName: string,
    mimeType: string,
    prefix?: string,
  ): Promise<UploadResult>;
  deleteObject(key: string): Promise<void>;
  readObject(key: string): Promise<Buffer>;
  /** Copies a stored object to a local file. */
  readObjectToFile(key: string, destination: string): Promise<void>;
  urlFor(key: string): string;
  keyFromUrl(url: string): string | undefined;
  createPresignedPut?(
    originalName: string,
    mimeType: string,
    prefix?: string,
  ): Promise<PresignedUpload>;
}
