import {
  Body,
  Controller,
  Param,
  Post,
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
import { MediaUploadService } from './media-upload.service';
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
  request(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestUploadDto) {
    return this.media.requestUpload(user.id, dto);
  }

  @Post('uploads/:id/file')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 80 * 1024 * 1024 },
    }),
  )
  receive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @UploadedFile() file: MulterFile,
  ) {
    return this.media.receiveFile(user.id, id, file);
  }

  @Post('uploads/:id/complete')
  complete(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.media.complete(user.id, id);
  }
}
