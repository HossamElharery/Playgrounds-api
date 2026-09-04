import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { StorageProvider, UploadResult } from './storage.interface';

/** Prod provider, activated by STORAGE_PROVIDER=s3 once real AWS credentials are supplied. */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBase?: string;
  private readonly region: string;

  constructor(private readonly config: ConfigService) {
    this.region = this.config.get<string>('AWS_REGION', 'us-east-1');
    this.bucket = this.config.get<string>('S3_BUCKET', '');
    this.publicBase = this.config.get<string>('S3_PUBLIC_BASE');
    this.client = new S3Client({ region: this.region });
  }

  async uploadBuffer(
    buffer: Buffer,
    originalName: string,
    mimeType: string,
    prefix = 'misc',
  ): Promise<UploadResult> {
    const ext = path.extname(originalName) || '';
    const key = `${prefix}/${randomUUID()}${ext}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        ServerSideEncryption: 'AES256',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return { key, url: this.urlFor(key) };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  urlFor(key: string): string {
    if (this.publicBase) return `${this.publicBase}/${key}`;
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }
}
