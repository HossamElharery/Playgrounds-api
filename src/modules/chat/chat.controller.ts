import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import type { MulterFile } from '../../common/types/multer-file.type';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { ChatService } from './chat.service';
import { StorageService } from '../storage/storage.service';
import { CreateDirectThreadDto } from './dto/create-direct-thread.dto';
import {
  CreateMatchThreadDto,
  CreateTeamThreadDto,
} from './dto/create-match-thread.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { RespondRequestDto } from './dto/respond-request.dto';
import { ReadStateDto } from './dto/read-state.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { UploadAttachmentDto } from './dto/upload-attachment.dto';
import { clampLimit } from '../../common/utils/page-limit.util';

@ApiTags('chat')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('chat')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly storage: StorageService,
  ) {}

  @Post('direct-threads')
  async createDirectThread(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDirectThreadDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { thread, created } = await this.chat.findOrCreateDirectThread(
      user.id,
      dto.participantId,
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return thread;
  }

  @Post('match-threads')
  createMatchThread(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMatchThreadDto,
  ) {
    return this.chat.findOrCreateMatchThread(
      user.id,
      dto.matchPostId,
      dto.title,
    );
  }

  @Post('team-threads')
  createTeamThread(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTeamThreadDto,
  ) {
    return this.chat.findOrCreateTeamThread(user.id, dto.teamId, dto.title);
  }

  @Get('message-access/:userId')
  messageAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
  ) {
    return this.chat.getMessageAccess(user.id, userId);
  }

  @Get('contact-quota')
  contactQuota(@CurrentUser() user: AuthenticatedUser) {
    return this.chat.getContactQuota(user.id);
  }

  @Post('threads/:threadId/request')
  respondToRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('threadId') threadId: string,
    @Body() dto: RespondRequestDto,
  ) {
    return this.chat.respondToRequest(user.id, threadId, dto.action);
  }

  @Get('threads')
  listThreads(@CurrentUser() user: AuthenticatedUser) {
    return this.chat.listMyThreads(user.id);
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return { chatUnreadCount: await this.chat.unreadCount(user.id) };
  }

  @Get('threads/:threadId')
  getThread(
    @CurrentUser() user: AuthenticatedUser,
    @Param('threadId') threadId: string,
  ) {
    return this.chat.getThread(user.id, threadId);
  }

  @Get('threads/:threadId/messages')
  listMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('threadId') threadId: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chat.listMessages(
      user.id,
      threadId,
      before,
      clampLimit(limit, 30, 100),
    );
  }

  @UseInterceptors(IdempotencyInterceptor)
  @Post('threads/:threadId/messages')
  sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('threadId') threadId: string,
    @Body() dto: SendMessageDto,
  ) {
    if (dto.type !== 'text') {
      // Attachments must be files this app uploaded, never arbitrary URLs.
      if (!dto.attachmentUrl || !this.storage.keyFromUrl(dto.attachmentUrl))
        throw new BadRequestException('Invalid attachment');
    }
    return this.chat.sendMessage(user.id, threadId, dto);
  }

  @Post('threads/:threadId/attachments')
  @UseInterceptors(
    // Cap the stream at the largest permitted attachment so multer aborts a
    // flood early instead of buffering an arbitrarily large body into memory
    // (the per-kind size check below still runs, but only after this guard).
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }),
  )
  async uploadAttachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('threadId') threadId: string,
    @UploadedFile() file: MulterFile,
    @Body() dto: UploadAttachmentDto,
  ) {
    const { clientMessageId, type = 'image', durationMs } = dto;
    const kind = type === 'voice' ? 'voice' : 'image';
    if (!file?.buffer?.length)
      throw new BadRequestException('File is required');
    if (!file.mimetype.startsWith(kind === 'voice' ? 'audio/' : 'image/'))
      throw new BadRequestException('Unsupported file type');
    if (file.size > (kind === 'voice' ? 5 : 10) * 1024 * 1024)
      throw new BadRequestException('File is too large');
    if (
      durationMs !== undefined &&
      !(
        Number.isFinite(Number(durationMs)) &&
        Number(durationMs) >= 0 &&
        Number(durationMs) <= 10 * 60 * 1000
      )
    )
      throw new BadRequestException('Invalid duration');
    await this.chat.assertCanAttach(user.id, threadId);
    const uploaded = await this.storage.uploadBuffer(
      file.buffer,
      file.originalname,
      file.mimetype,
      'chat',
    );
    return this.chat.attachFile(
      user.id,
      threadId,
      { url: uploaded.url, mime: file.mimetype, size: file.size },
      clientMessageId ?? `att-${Date.now()}`,
      type === 'voice' ? 'voice' : 'image',
      durationMs ? Number(durationMs) : undefined,
    );
  }

  @Patch('threads/:threadId/messages/:messageId')
  editMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('threadId') threadId: string,
    @Param('messageId') messageId: string,
    @Body() dto: EditMessageDto,
  ) {
    return this.chat.editMessage(user.id, threadId, messageId, dto.text);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('threads/:threadId/messages/:messageId')
  deleteMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('threadId') threadId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.chat.deleteMessage(user.id, threadId, messageId);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Put('threads/:threadId/read-state')
  setReadState(
    @CurrentUser() user: AuthenticatedUser,
    @Param('threadId') threadId: string,
    @Body() dto: ReadStateDto,
  ) {
    return this.chat.setReadState(user.id, threadId, dto.lastReadMessageId);
  }
}
