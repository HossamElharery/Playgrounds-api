import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StorageProvider, UploadResult } from './storage.interface';

/** Dev-default provider: saves under ./uploads, served statically at STORAGE_LOCAL_PUBLIC_BASE. */
@Injectable()
export class LocalDiskStorageProvider implements StorageProvider {
  private readonly root = path.join(process.cwd(), 'uploads');
  private readonly publicBase: string;

  constructor(private readonly config: ConfigService) {
    this.publicBase = this.config.get<string>(
      'STORAGE_LOCAL_PUBLIC_BASE',
      '/uploads',
    );
  }

  async uploadBuffer(
    buffer: Buffer,
    originalName: string,
    _mimeType: string,
    prefix = 'misc',
  ): Promise<UploadResult> {
    const ext = path.extname(originalName) || '';
    const key = `${prefix}/${randomUUID()}${ext}`;
    const fullPath = path.join(this.root, key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, buffer);
    return { key, url: this.urlFor(key) };
  }

  async deleteObject(key: string): Promise<void> {
    await fs.rm(path.join(this.root, key), { force: true });
  }

  urlFor(key: string): string {
    return `${this.publicBase}/${key}`;
  }

  keyFromUrl(url: string): string | undefined {
    const base = this.publicBase.endsWith('/')
      ? this.publicBase
      : `${this.publicBase}/`;
    if (url.startsWith(base)) return url.slice(base.length);
    try {
      const pathname = new URL(url).pathname;
      if (pathname.startsWith(base)) return pathname.slice(base.length);
    } catch {
      /* relative non-matching path */
    }
    return undefined;
  }
}
