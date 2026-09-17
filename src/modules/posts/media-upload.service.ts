import { BadRequestException, Injectable } from '@nestjs/common';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { RequestUploadDto } from './dto/request-upload.dto';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 90;

@Injectable()
export class MediaUploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async requestUpload(userId: string, dto: RequestUploadDto) {
    this.validateMeta(dto);
    const ext = extname(dto.filename) || (dto.type === 'video' ? '.mp4' : '.jpg');
    const key = `posts/${randomUUID()}${ext}`;
    const asset = await this.prisma.mediaAsset.create({
      data: {
        userId,
        type: dto.type,
        key,
        url: this.storage.urlFor(key),
        thumbnailUrl: dto.type === 'image' ? this.storage.urlFor(key) : '',
        mimeType: dto.mimeType,
        width: dto.width ?? 0,
        height: dto.height ?? 0,
        durationSeconds: dto.durationSeconds,
        altText: dto.altText,
        status: 'pending',
      },
    });
    return {
      assetId: asset.id,
      uploadUrl: `/api/v1/media/uploads/${asset.id}/file`,
      method: 'POST' as const,
      headers: {},
      mode: 'multipart' as const,
    };
  }

  async receiveFile(
    userId: string,
    assetId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  ) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, userId },
    });
    if (!asset) throw new BadRequestException('Unknown upload');
    this.validateMeta({
      filename: file.originalname,
      mimeType: file.mimetype,
      byteSize: file.size,
      type: asset.type,
      durationSeconds: asset.durationSeconds ?? undefined,
    });
    const uploaded = await this.storage.uploadBuffer(
      file.buffer,
      file.originalname,
      file.mimetype,
      'posts',
    );
    const thumbnailUrl =
      asset.type === 'video'
        ? await this.maybeThumbnail(uploaded.key, file.buffer)
        : uploaded.url;
    return this.prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        key: uploaded.key,
        url: uploaded.url,
        thumbnailUrl: thumbnailUrl || uploaded.url,
        mimeType: file.mimetype,
        status: 'ready',
      },
    });
  }

  async complete(userId: string, assetId: string) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, userId },
    });
    if (!asset) throw new BadRequestException('Unknown upload');
    const thumbnailUrl =
      asset.type === 'video' && !asset.thumbnailUrl
        ? asset.url
        : asset.thumbnailUrl || asset.url;
    return this.prisma.mediaAsset.update({
      where: { id: assetId },
      data: { status: 'ready', thumbnailUrl },
    });
  }

  private validateMeta(dto: {
    filename: string;
    mimeType: string;
    byteSize: number;
    type: 'image' | 'video';
    durationSeconds?: number;
  }) {
    if (dto.type === 'image') {
      if (!IMAGE_TYPES.has(dto.mimeType)) {
        throw new BadRequestException('Unsupported image type');
      }
      if (dto.byteSize > MAX_IMAGE_BYTES) {
        throw new BadRequestException('Image is too large');
      }
    } else {
      if (!VIDEO_TYPES.has(dto.mimeType)) {
        throw new BadRequestException('Unsupported video type');
      }
      if (dto.byteSize > MAX_VIDEO_BYTES) {
        throw new BadRequestException('Video is too large');
      }
      if ((dto.durationSeconds ?? 0) > MAX_VIDEO_SECONDS) {
        throw new BadRequestException('Video must be 90 seconds or shorter');
      }
    }
  }

  private async maybeThumbnail(_key: string, _buffer: Buffer): Promise<string> {
    // ffmpeg is optional in local/dev. When missing, the video URL is used as poster.
    return '';
  }
}
