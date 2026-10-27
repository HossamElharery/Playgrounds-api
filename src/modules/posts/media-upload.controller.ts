import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import type { MulterFile } from '../../common/types/multer-file.type';
import {
  MediaUploadService,
  SINGLE_UPLOAD_MAX_BYTES,
  UPLOAD_CHUNK_BYTES,
} from './media-upload.service';
import { RequestUploadDto } from './dto/request-upload.dto';
import { memoryStorage } from 'multer';

@ApiTags('media')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('media')
export class MediaUploadController {
  constructor(private readonly media: MediaUploadService) {}

  @Post('uploads')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestUploadDto,
  ) {
    return this.media.requestUpload(user.id, dto);
  }

  @Post('uploads/:id/file')
  @Throttle({
    burst: { limit: 2, ttl: 1_000 },
    short: { limit: 4, ttl: 10_000 },
    default: { limit: 6, ttl: 60_000 },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: SINGLE_UPLOAD_MAX_BYTES },
    }),
  )
  receive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @UploadedFile() file: MulterFile,
  ) {
    return this.media.receiveFile(user.id, id, file);
  }

  @Get('uploads/:id/chunks')
  chunkStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.media.chunkStatus(user.id, id);
  }

  /** One slice of a large video: `chunk` is the bytes, `offset` where they start. */
  @Post('uploads/:id/chunks')
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: memoryStorage(),
      limits: { fileSize: UPLOAD_CHUNK_BYTES },
    }),
  )
  receiveChunk(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('offset') offset: string,
    @UploadedFile() chunk: MulterFile,
  ) {
    return this.media.receiveChunk(user.id, id, offset ? Number(offset) : Number.NaN, chunk?.buffer);
  }

  @Post('uploads/:id/chunks/finish')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  finishChunks(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.media.finishChunks(user.id, id);
  }

  @Post('uploads/:id/complete')
  complete(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.media.complete(user.id, id);
  }
}
